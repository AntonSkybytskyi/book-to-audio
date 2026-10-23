// Runs core for `pnpm dev`: starts it again when a file under src/ changes, like `tsx watch`. Unlike
// `tsx watch`, it stops when core fails before anything was changed (a bad setting, the port in use), so
// `pnpm dev` stops with it instead of carrying on while every request through nginx fails.
import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";

const CORE = ["--import", "tsx", "src/index.ts"];
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
    console.error(`core stopped (${signal ?? `exit code ${code}`}): waiting for a change in src/.`);
  });
}

watch("src", { recursive: true }, (_event, file) => {
  if (!file?.endsWith(".ts") || file.endsWith(".test.ts")) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    changed = true;
    if (!core) start();
    else if (!restarting) {
      restarting = true;
      core.kill("SIGTERM");
    }
  }, SETTLE_MS);
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
