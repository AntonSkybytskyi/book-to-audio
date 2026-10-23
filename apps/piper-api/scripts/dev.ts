// Runs piper-api for `pnpm dev`: starts it again when a file under src/ changes, or when the contracts are
// rebuilt, like `tsx watch`. Unlike `tsx watch`, it stops when the service fails before anything was
// changed (a bad setting, the port in use), so `pnpm dev` stops with it. The same as core's scripts/dev.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";

const SERVICE = ["--import", "tsx", "src/index.ts"];
/** The service loads the contracts from their build, which `pnpm dev` keeps current with `tsc --watch`. */
const CONTRACTS_BUILD = "../../packages/contracts/dist";
/** Editors write a file in several steps; one restart covers them. */
const SETTLE_MS = 150;

let service: ChildProcess | undefined;
let restarting = false;
let stopping = false;
let changed = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function start() {
  const child = spawn(process.execPath, SERVICE, { stdio: "inherit" });
  service = child;
  child.on("exit", (code, signal) => {
    service = undefined;
    if (stopping) return;
    if (restarting) {
      restarting = false;
      start();
      return;
    }
    const how = signal ?? `exit code ${code}`;
    if (!changed) {
      console.error(`piper-api stopped (${how}) before any change: stopping.`);
      process.exit(code || 1);
    }
    console.error(`piper-api stopped (${how}): waiting for a change in src/ or the contracts.`);
  });
}

function restartSoon() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    changed = true;
    if (!service) start();
    else if (!restarting) {
      restarting = true;
      service.kill("SIGTERM");
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
    if (!service) process.exit(0);
    stopping = true;
    service.once("exit", () => process.exit(0));
    service.kill(signal);
  });
}

start();
