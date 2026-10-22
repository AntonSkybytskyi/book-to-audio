import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { PiperEngine } from "../tts/piper.js";

// A stand-in `piper` that speaks the `--json-input` protocol: one JSON line in, a
// WAV file of one sample per character written, and its path printed when done.
// Markers in the text make it misbehave: HANG never answers, CRASH dies, EMPTY writes no samples.
export const FAKE_PIPER = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

import { spawn } from "node:child_process";
const log = process.env.FAKE_PIPER_LOG;
// A wrapper script runs the real binary as a child; this one starts a child of its own.
if (process.env.FAKE_PIPER_CHILD) {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  fs.appendFileSync(process.env.FAKE_PIPER_CHILD, child.pid + "\\n");
}
if (log) fs.appendFileSync(log, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + "\\n");

const wav = (samples) => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(22050, 24);
  header.writeUInt32LE(44100, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const { text, output_file } = request;
  if (log) fs.appendFileSync(log + ".requests", line + "\\n");
  if (text.includes("HANG")) return;
  if (text.includes("CRASH")) {
    process.stderr.write("OnnxRuntime: bad model\\n");
    process.exit(1);
  }
  const samples = text.includes("EMPTY") ? Buffer.alloc(0) : Buffer.alloc(text.length * 2, 1);
  fs.writeFileSync(output_file, wav(samples));
  console.log(output_file);
});
`;

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
 * A voices folder with one English voice, a stand-in `piper` script that logs how it was started,
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
    script = path.join(dir, "fake-piper.mjs");
    fs.writeFileSync(script, FAKE_PIPER, { mode: 0o755 });
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
