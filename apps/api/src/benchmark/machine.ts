import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MachineInfo } from "./repository.js";

/** What the results depend on: how many cores this process may use, and which processor they are. */
export function currentMachine(): MachineInfo {
  return {
    cpuCount: os.availableParallelism(),
    cpuModel: cpuModel(),
  };
}

function cpuModel(): string {
  const model = os.cpus()[0]?.model.trim();
  // Some virtual machines (Docker on Apple silicon) report nothing useful; the architecture still says something.
  return model && model !== "unknown" ? model : `${os.arch()} processor`;
}

/** The benchmark's scratch folders are only ever left behind by a crash: remove them at startup. */
export function removeBenchmarkLeftovers(scratchDir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(scratchDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith("benchmark-")) {
      fs.rmSync(path.join(scratchDir, name), { recursive: true, force: true });
    }
  }
}
