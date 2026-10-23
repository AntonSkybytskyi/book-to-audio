#!/usr/bin/env node
// A stand-in `piper` for development and tests, so neither needs the real binary or models. It speaks
// the `--json-input` protocol: one JSON line in, a WAV file written to `output_file`, and its path
// printed when done. The WAV has one quiet sample per character, or with FAKE_PIPER_TONE=1 a tone as
// long as the text would take to read.
//
// Markers in the text make it misbehave like the real engine can:
//   HANG never answers, CRASH dies, EMPTY writes no samples (tests);
//   FAKE_PIPER_FAIL_MARKER dies, FAKE_PIPER_BAD_MARKER writes no samples (unreadable text), and
//   FAKE_PIPER_FLAKY_MARKER dies on the first two attempts at a text, then reads it (development).
// FAKE_PIPER_DELAY_MS makes every chunk take that long, so progress is visible in the UI.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const SAMPLE_RATE = 22050;
/** Roughly the pace of spoken English. */
const CHARS_PER_SECOND = 15;
const FLAKY_FAILURES = 2;

const env = process.env;
const log = env.FAKE_PIPER_LOG;
const delayMs = Number(env.FAKE_PIPER_DELAY_MS || 0);
const markers = {
  fail: env.FAKE_PIPER_FAIL_MARKER || undefined,
  bad: env.FAKE_PIPER_BAD_MARKER || undefined,
  flaky: env.FAKE_PIPER_FLAKY_MARKER || undefined,
};
// A failed attempt ends the process, so the attempts are counted in a file.
const flakyLog = path.join(env.FAKE_PIPER_STATE_DIR || os.tmpdir(), "fake-piper-flaky.log");

// A wrapper script runs the real binary as a child; this one starts a child of its own.
if (env.FAKE_PIPER_CHILD) {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  fs.appendFileSync(env.FAKE_PIPER_CHILD, `${child.pid}\n`);
}
if (log)
  fs.appendFileSync(log, `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) })}\n`);

const wav = (samples) => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
};

const tone = (text) => {
  const count = Math.round(Math.max(0.2, text.length / CHARS_PER_SECOND) * SAMPLE_RATE);
  const samples = Buffer.alloc(count * 2);
  const fade = Math.round(0.02 * SAMPLE_RATE);
  for (let i = 0; i < count; i++) {
    const envelope = Math.min(1, i / fade, (count - i) / fade);
    const value = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 3000 * envelope;
    samples.writeInt16LE(Math.round(value), i * 2);
  }
  return samples;
};

const die = (why) => {
  process.stderr.write(`${why}\n`);
  process.exit(1);
};

const flakyAttempt = (text) => {
  const key = createHash("sha1").update(text).digest("hex");
  fs.appendFileSync(flakyLog, `${key}\n`);
  return fs
    .readFileSync(flakyLog, "utf8")
    .split("\n")
    .filter((line) => line === key).length;
};

const lines = readline.createInterface({ input: process.stdin });
const queue = [];
let busy = false;

async function next() {
  if (busy) return;
  busy = true;
  while (queue.length > 0) await read(queue.shift());
  busy = false;
}

async function read(line) {
  const request = JSON.parse(line);
  const { text, output_file } = request;
  if (log) fs.appendFileSync(`${log}.requests`, `${line}\n`);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (text.includes("HANG")) return new Promise(() => {});
  if (text.includes("CRASH")) die("OnnxRuntime: bad model");
  if (markers.fail && text.includes(markers.fail)) die(`fake piper: fail marker "${markers.fail}"`);
  if (markers.flaky && text.includes(markers.flaky) && flakyAttempt(text) <= FLAKY_FAILURES) {
    die(`fake piper: flaky marker "${markers.flaky}"`);
  }
  const empty = text.includes("EMPTY") || (markers.bad && text.includes(markers.bad));
  const samples = empty
    ? Buffer.alloc(0)
    : env.FAKE_PIPER_TONE === "1"
      ? tone(text)
      : Buffer.alloc(text.length * 2, 1);
  fs.writeFileSync(output_file, wav(samples));
  console.log(output_file);
}

lines.on("line", (line) => {
  queue.push(line);
  void next();
});
