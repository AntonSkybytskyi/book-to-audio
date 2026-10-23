import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "vitest";
import { PiperEngine } from "../piper.js";

/** The stand-in `piper` that development uses too; see the comment at its top. */
export const FAKE_PIPER = fileURLToPath(new URL("../../dev/fake-piper.mjs", import.meta.url));

export const VOICE = "en_US-lessac-medium";

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A voices folder with one English voice, the stand-in `piper` logging how it was started,
 * and a scratch folder, made before each test and removed after it. Call it inside a `describe`.
 */
export function usePiperFixture() {
  let dir = "";
  let voicesDir = "";
  let script = "";
  let logFile = "";
  let scratchDir = "";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "piper-test-"));
    voicesDir = path.join(dir, "voices");
    fs.mkdirSync(voicesDir);
    const config = { audio: { sample_rate: 22050 }, language: { family: "en", code: "en_US" } };
    fs.writeFileSync(path.join(voicesDir, "en_US-lessac-medium.onnx"), "model");
    fs.writeFileSync(path.join(voicesDir, "en_US-lessac-medium.onnx.json"), JSON.stringify(config));
    // Not usable: no config next to the model.
    fs.writeFileSync(path.join(voicesDir, "broken.onnx"), "model");
    fs.writeFileSync(path.join(voicesDir, "notes.txt"), "ignored");
    script = FAKE_PIPER;
    logFile = path.join(dir, "starts.log");
    scratchDir = path.join(dir, "scratch");
    process.env.FAKE_PIPER_LOG = logFile;
  });

  const starts = (): { pid: number; argv: string[] }[] =>
    fs.existsSync(logFile)
      ? fs
          .readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { pid: number; argv: string[] })
      : [];

  afterEach(() => {
    delete process.env.FAKE_PIPER_LOG;
    for (const { pid } of starts()) {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    get dir() {
      return dir;
    },
    get voicesDir() {
      return voicesDir;
    },
    get script() {
      return script;
    },
    get logFile() {
      return logFile;
    },
    get scratchDir() {
      return scratchDir;
    },
    starts,
    // The first chunk gets 5 s extra for starting node; later chunks only `timeoutMs`.
    engineWith: (timeoutMs = 5000, bin = script) =>
      new PiperEngine({ bin, voicesDir, timeoutMs, startupGraceMs: 5000, scratchDir }),
  };
}
