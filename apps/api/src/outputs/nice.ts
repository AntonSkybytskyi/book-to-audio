import { spawnSync } from "node:child_process";

/** `nice`, if this system has it: it runs ffmpeg at a lower priority, so a build leaves the CPU to the TTS workers. */
export function findNice(): string | null {
  const probe = spawnSync("nice", ["-n", "10", process.execPath, "-e", ""], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0 ? "nice" : null;
}
