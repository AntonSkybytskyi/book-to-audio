import fs from "node:fs";
import path from "node:path";

/** Whether `bin` (a path, or a name looked up on PATH) is an executable file. */
export function isExecutable(bin: string, envPath = process.env.PATH ?? ""): boolean {
  const candidates = bin.includes("/")
    ? [path.resolve(bin)]
    : envPath
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, bin));
  return candidates.some((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}
