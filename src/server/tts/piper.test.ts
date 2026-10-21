import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { until } from "../testing/pool-harness.js";
import { PiperEngine } from "./piper.js";
import { wavToPcm } from "./piper-session.js";

// A stand-in `piper` that speaks the `--json-input` protocol: one JSON line in, a
// WAV file of one sample per character written, and its path printed when done.
// Markers in the text make it misbehave: HANG never answers, CRASH dies, EMPTY writes no samples.
const FAKE_PIPER = `#!/usr/bin/env node
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
  const { text, output_file } = JSON.parse(line);
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

const mode = (file: string) => fs.statSync(file).mode & 0o777;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("PiperEngine", () => {
  let dir: string;
  let voicesDir: string;
  let script: string;
  let logFile: string;
  let scratchDir: string;

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

  afterEach(() => {
    delete process.env.FAKE_PIPER_LOG;
    for (const { pid } of starts()) {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    fs.rmSync(dir, { recursive: true, force: true });
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

  // The first chunk gets 5 s extra for starting node; later chunks only `timeoutMs`.
  const engineWith = (timeoutMs = 5000, bin = script) =>
    new PiperEngine({ bin, voicesDir, timeoutMs, startupGraceMs: 5000, scratchDir });
  const VOICE = "en_US-lessac-medium";

  it("lists the voices that have a model and a config", () => {
    expect(engineWith().voices()).toEqual([
      { id: VOICE, language: "en", name: VOICE, sampleRate: 22050 },
    ]);
  });

  it("has no voices when the directory is missing", () => {
    const engine = new PiperEngine({ bin: "piper", voicesDir: path.join(voicesDir, "nope") });

    expect(engine.voices()).toEqual([]);
  });

  it("starts one process in JSON mode and reuses it for every chunk", async () => {
    const session = await engineWith().open(VOICE);

    const first = await session.synthesize("Hello world.");
    const second = await session.synthesize("Second chunk, a bit longer.");
    await session.synthesize("Third.");
    await session.close();

    expect(first).toMatchObject({ sampleRate: 22050, channels: 1 });
    expect(first.samples.length).toBe("Hello world.".length * 2);
    expect(second.samples.length).toBe("Second chunk, a bit longer.".length * 2);
    const started = starts();
    expect(started).toHaveLength(1);
    expect(started[0]?.argv).toEqual([
      "--model",
      path.join(voicesDir, `${VOICE}.onnx`),
      "--json-input",
      "--output_dir",
      expect.stringContaining(scratchDir),
    ]);
  });

  it("keeps paragraph breaks inside one request", async () => {
    const session = await engineWith().open(VOICE);

    const pcm = await session.synthesize("One.\nTwo.\n");

    expect(pcm.samples.length).toBe("One.\nTwo.".length * 2); // trimmed, newline kept
    await session.close();
  });

  it("removes the process and its scratch directory on close, and close can repeat", async () => {
    const session = await engineWith().open(VOICE);
    await session.synthesize("Hello.");
    const [{ pid, argv } = { pid: 0, argv: [] }] = starts();
    const scratch = argv.at(-1) ?? "";
    expect(fs.existsSync(scratch)).toBe(true);

    await session.close();
    await session.close();

    expect(alive(pid)).toBe(false);
    expect(fs.existsSync(scratch)).toBe(false);
    await expect(session.synthesize("More.")).rejects.toMatchObject({ code: "synthesis_failed" });
  });

  it("leaves no WAV files behind between chunks", async () => {
    const session = await engineWith().open(VOICE);
    await session.synthesize("Hello.");
    const scratch = starts()[0]?.argv.at(-1) ?? "";

    expect(fs.readdirSync(scratch)).toEqual([]);
    await session.close();
  });

  it("reports a missing binary as engine_unavailable", async () => {
    await expect(
      engineWith(5000, path.join(dir, "no-such-piper")).open(VOICE),
    ).rejects.toMatchObject({
      code: "engine_unavailable",
      message: expect.stringContaining("not installed"),
    });
  });

  it("keeps stderr out of the message and in the detail when piper dies", async () => {
    const session = await engineWith().open(VOICE);

    const error = await session.synthesize("CRASH now").catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: "synthesis_failed",
      message: "The speech engine stopped unexpectedly.",
      detail: expect.stringMatching(/code 1.*bad model/),
    });
    expect((error as Error).message).not.toContain("OnnxRuntime");
    await session.close();
  });

  it("kills a process that hangs on a chunk and reports a timeout", async () => {
    const session = await engineWith(100).open(VOICE);
    await session.synthesize("Warm up."); // the first chunk also pays for starting node
    const [{ pid } = { pid: 0 }] = starts();

    await expect(session.synthesize("HANG forever")).rejects.toMatchObject({ code: "timeout" });

    await expect(session.synthesize("Again.")).rejects.toMatchObject({ code: "synthesis_failed" });
    expect(alive(pid)).toBe(false);
    await session.close();
  });

  it("kills the process when the signal aborts", async () => {
    const session = await engineWith().open(VOICE);
    await session.synthesize("Warm up.");
    const [{ pid } = { pid: 0 }] = starts();
    const controller = new AbortController();

    const outcome = session.synthesize("HANG forever", controller.signal).catch((e: unknown) => e);
    controller.abort();

    expect(await outcome).toMatchObject({ code: "aborted" });
    await session.close();
    expect(alive(pid)).toBe(false);
  });

  it("refuses a chunk when the signal is already aborted", async () => {
    const session = await engineWith().open(VOICE);

    await expect(session.synthesize("Hello.", AbortSignal.abort())).rejects.toMatchObject({
      code: "aborted",
    });
    expect(alive(starts()[0]?.pid ?? 0)).toBe(true); // nothing was cancelled, the process is fine
    await session.close();
  });

  it("fails a chunk that produces no audio", async () => {
    const session = await engineWith().open(VOICE);

    await expect(session.synthesize("EMPTY")).rejects.toMatchObject({
      code: "bad_input",
      message: expect.stringContaining("no audio"),
    });
    await session.close();
  });

  it("closes a session that is waiting on a chunk", async () => {
    const session = await engineWith().open(VOICE);
    await session.synthesize("Warm up.");

    const outcome = session.synthesize("HANG forever").catch((e: unknown) => e);
    await session.close();

    expect(await outcome).toMatchObject({ code: "aborted" });
  });

  const root = () => path.join(scratchDir, `piper-${process.pid}`);
  const make = (name: string) => {
    fs.mkdirSync(path.join(scratchDir, name, "session-x"), { recursive: true });
    return path.join(scratchDir, name);
  };

  describe("scratch folder", () => {
    it("is private to this app process, inside the data directory's tmp folder", async () => {
      const session = await engineWith().open(VOICE);
      await session.synthesize("Hello.");

      expect(mode(root())).toBe(0o700);
      const [name] = fs.readdirSync(root());
      expect(name).toMatch(/^session-/);
      expect(mode(path.join(root(), name ?? ""))).toBe(0o700);
      await session.close();
    });

    it("refuses a folder that others can use", async () => {
      fs.mkdirSync(root(), { recursive: true, mode: 0o755 });
      fs.chmodSync(root(), 0o755);

      await expect(engineWith().open(VOICE)).rejects.toMatchObject({
        code: "engine_unavailable",
        detail: expect.stringContaining("mode 700"),
      });
      expect(starts()).toEqual([]);
    });

    it("refuses a symlink in its place", async () => {
      const elsewhere = path.join(dir, "elsewhere");
      fs.mkdirSync(elsewhere, { mode: 0o700 });
      fs.mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
      fs.symlinkSync(elsewhere, root());

      await expect(engineWith().open(VOICE)).rejects.toMatchObject({ code: "engine_unavailable" });
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    });

    it("removes the folders of app processes that are gone, and only those", () => {
      const dead = make("piper-2147483646"); // no such process
      const mine = make(`piper-${process.pid}`); // left by an earlier run with the same id
      const running = make(`piper-${process.ppid}`); // another app that is still running
      const stranger = make("something-else");

      engineWith().removeLeftovers();

      expect(fs.existsSync(dead)).toBe(false);
      expect(fs.existsSync(mine)).toBe(false);
      expect(fs.existsSync(running)).toBe(true);
      expect(fs.existsSync(stranger)).toBe(true);
    });

    it("does nothing when there is no scratch folder yet", () => {
      expect(() => engineWith().removeLeftovers()).not.toThrow();
    });
  });

  it("kills what a wrapper script started along with it", async () => {
    process.env.FAKE_PIPER_CHILD = path.join(dir, "children.log");
    try {
      const session = await engineWith().open(VOICE);
      await session.synthesize("Warm up.");
      const [{ pid } = { pid: 0 }] = starts();
      const child = Number(fs.readFileSync(process.env.FAKE_PIPER_CHILD, "utf8").trim());
      expect(alive(child)).toBe(true);

      const controller = new AbortController();
      const outcome = session
        .synthesize("HANG forever", controller.signal)
        .catch((e: unknown) => e);
      controller.abort();
      await outcome;

      await until(() => !alive(child) && !alive(pid));
      await session.close();
    } finally {
      delete process.env.FAKE_PIPER_CHILD;
    }
  });

  it("rejects unknown voices without starting anything", async () => {
    await expect(engineWith().open("other")).rejects.toMatchObject({ code: "voice_not_found" });
    expect(starts()).toEqual([]);
  });

  it("scans the voices directory once per TTL, not on every call", () => {
    let clock = 0;
    const engine = new PiperEngine({ bin: "piper", voicesDir, scanTtlMs: 1000, now: () => clock });
    expect(engine.voices()).toHaveLength(1);

    fs.writeFileSync(path.join(voicesDir, "de.onnx"), "model");
    fs.writeFileSync(
      path.join(voicesDir, "de.onnx.json"),
      JSON.stringify({ audio: { sample_rate: 16000 }, language: { family: "de" } }),
    );
    clock = 999;
    expect(engine.voices()).toHaveLength(1); // cached
    clock = 1000;
    expect(engine.voices().map((v) => v.language)).toEqual(["de", "en"]);
  });

  it("caches a missing voices directory too", () => {
    let clock = 0;
    const engine = new PiperEngine({
      bin: "piper",
      voicesDir: path.join(voicesDir, "later"),
      scanTtlMs: 1000,
      now: () => clock,
    });
    expect(engine.voices()).toEqual([]);

    fs.mkdirSync(path.join(voicesDir, "later"));
    for (const file of ["en_US-lessac-medium.onnx", "en_US-lessac-medium.onnx.json"]) {
      fs.copyFileSync(path.join(voicesDir, file), path.join(voicesDir, "later", file));
    }
    expect(engine.voices()).toEqual([]);
    clock = 1000;
    expect(engine.voices()).toHaveLength(1);
  });
});

const chunk = (id: string, body: Buffer) => {
  const head = Buffer.alloc(8);
  head.write(id, 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const riff = (...chunks: Buffer[]) => {
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), ...chunks]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

describe("wavToPcm", () => {
  it("returns the data chunk, skipping chunks before it", () => {
    const wav = riff(
      chunk("fmt ", Buffer.alloc(16)),
      chunk("LIST", Buffer.alloc(5)),
      chunk("data", Buffer.from([1, 0, 2, 0])),
    );

    expect(wavToPcm(wav)).toEqual(Buffer.from([1, 0, 2, 0]));
  });

  it("reads to the end when the data size is unset or too large", () => {
    const data = Buffer.concat([
      Buffer.from("data", "latin1"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([5, 0, 6, 0, 7]),
    ]);
    const wav = Buffer.concat([riff(), data]);

    expect(wavToPcm(wav)).toEqual(Buffer.from([5, 0, 6, 0])); // whole samples only
  });

  it("rejects anything that is not a WAV with data", () => {
    expect(() => wavToPcm(Buffer.from("nope"))).toThrow(/no audio/);
    expect(() => wavToPcm(riff(chunk("fmt ", Buffer.alloc(16))))).toThrow(/no audio/);
  });
});
