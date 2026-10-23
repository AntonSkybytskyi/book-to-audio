// Runs core for `pnpm dev`: starts it again when a file under src/ changes, or when the contracts are
// rebuilt, like `tsx watch`. Unlike `tsx watch`, it stops when core fails before anything was changed (a
// bad setting, the port in use), so `pnpm dev` stops with it instead of carrying on while every request
// through nginx fails.
import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";

const CORE = ["--import", "tsx", "src/index.ts"];
/**
 * Core loads the contracts from their build, which `pnpm dev` keeps current with `tsc --watch`, so a
 * change there must restart core too, or core keeps running the old code while web has the new.
 */
const CONTRACTS_BUILD = "../../packages/contracts/dist";
/** Editors write a file in several steps; one restart covers them. */
const SETTLE_MS = 150;

let core: ChildProcess | undefined;
let restarting = false;
let stopping = false;
let changed = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function start() {
  const child = spawn(process.execPath, CORE, { stdio: "inherit" });
  core = child;
  child.on("exit", (code, signal) => {
    core = undefined;
    if (stopping) return;
    if (restarting) {
      restarting = false;
      start();
      return;
    }
    if (!changed) {
      console.error(`core stopped (${signal ?? `exit code ${code}`}) before any change: stopping.`);
      process.exit(code || 1);
    }
    console.error(
      `core stopped (${signal ?? `exit code ${code}`}): waiting for a change in src/ or the contracts.`,
    );
  });
}

function restartSoon() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    changed = true;
    if (!core) start();
    else if (!restarting) {
      restarting = true;
      core.kill("SIGTERM");
    }
  }, SETTLE_MS);
}

watch("src", { recursive: true }, (_event, file) => {
  if (file?.endsWith(".ts") && !file.endsWith(".test.ts")) restartSoon();
});
watch(CONTRACTS_BUILD, { recursive: true }, (_event, file) => {
  if (file?.endsWith(".js")) restartSoon();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (!core) process.exit(0);
    stopping = true;
    core.once("exit", () => process.exit(0));
    core.kill(signal);
  });
}

start();
