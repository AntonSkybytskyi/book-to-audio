import { spawnSync } from "node:child_process";

/** True when `name` can be started, for `describe.skipIf(!hasBinary("ffmpeg"))`. */
export function hasBinary(name: string): boolean {
  return spawnSync(name, ["-version"], { stdio: "ignore" }).error === undefined;
}
