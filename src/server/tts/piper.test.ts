import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunner, RunResult } from "../process.js";
import { PiperEngine } from "./piper.js";

const ok = (stdout: Buffer): RunResult => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  aborted: false,
});

const missingBinary: ProcessRunner = async () => {
  throw Object.assign(new Error("spawn piper ENOENT"), { code: "ENOENT" });
};
const crashing: ProcessRunner = async () => ({
  ...ok(Buffer.alloc(0)),
  code: 1,
  stderr: "line one\nOnnxRuntime: bad model",
});
const timedOut: ProcessRunner = async () => ({
  ...ok(Buffer.alloc(0)),
  code: null,
  timedOut: true,
});
const aborted: ProcessRunner = async () => ({ ...ok(Buffer.alloc(0)), code: null, aborted: true });
const silent: ProcessRunner = async () => ok(Buffer.alloc(0));

describe("PiperEngine", () => {
  let voicesDir: string;

  beforeEach(() => {
    voicesDir = fs.mkdtempSync(path.join(os.tmpdir(), "piper-voices-"));
    const config = { audio: { sample_rate: 22050 }, language: { family: "en", code: "en_US" } };
    fs.writeFileSync(path.join(voicesDir, "en_US-lessac-medium.onnx"), "model");
    fs.writeFileSync(path.join(voicesDir, "en_US-lessac-medium.onnx.json"), JSON.stringify(config));
    // Not usable: no config next to the model.
    fs.writeFileSync(path.join(voicesDir, "broken.onnx"), "model");
    fs.writeFileSync(path.join(voicesDir, "notes.txt"), "ignored");
  });

  afterEach(() => {
    fs.rmSync(voicesDir, { recursive: true, force: true });
  });

  const engineWith = (run: ProcessRunner, timeoutMs = 1000) =>
    new PiperEngine({ bin: "piper", voicesDir, run, timeoutMs });
  const request = { text: "Hello world.", voiceId: "en_US-lessac-medium", speed: 1 };

  it("lists the voices that have a model and a config", () => {
    expect(engineWith(vi.fn()).voices()).toEqual([
      { id: "en_US-lessac-medium", language: "en", name: "en_US-lessac-medium" },
    ]);
  });

  it("has no voices when the directory is missing", () => {
    const engine = new PiperEngine({ bin: "piper", voicesDir: path.join(voicesDir, "nope") });

    expect(engine.voices()).toEqual([]);
  });

  it("passes the text on stdin and reads raw PCM from stdout", async () => {
    const run = vi.fn<ProcessRunner>(async () => ok(Buffer.from([1, 0, 2, 0, 3])));

    const pcm = await engineWith(run).synthesize({ ...request, speed: 2 });

    expect(pcm).toMatchObject({ sampleRate: 22050, channels: 1 });
    expect(pcm.samples).toEqual(Buffer.from([1, 0, 2, 0])); // The odd trailing byte is dropped.
    const [bin, args, options] = run.mock.calls[0] ?? [];
    expect(bin).toBe("piper");
    expect(args).toEqual([
      "--model",
      path.join(voicesDir, "en_US-lessac-medium.onnx"),
      "--output_raw",
      "--length_scale",
      "0.5",
    ]);
    expect(options).toMatchObject({ input: "Hello world.\n", timeoutMs: 1000 });
  });

  it("keeps paragraph breaks as separate lines", async () => {
    const run = vi.fn<ProcessRunner>(async () => ok(Buffer.alloc(4)));

    await engineWith(run).synthesize({ ...request, text: "One.\nTwo." });

    expect(run.mock.calls[0]?.[2].input).toBe("One.\nTwo.\n");
  });

  it("reports a missing binary as engine_unavailable", async () => {
    await expect(engineWith(missingBinary).synthesize(request)).rejects.toMatchObject({
      code: "engine_unavailable",
      message: expect.stringContaining("not installed"),
    });
  });

  it("keeps stderr out of the message and in the detail when piper exits with an error", async () => {
    const error = await engineWith(crashing)
      .synthesize(request)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: "synthesis_failed",
      message: "The speech engine failed on this chapter.",
      detail: expect.stringMatching(/code 1.*bad model/),
    });
    expect((error as Error).message).not.toContain("OnnxRuntime");
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

  it("fails when piper produces no audio", async () => {
    await expect(engineWith(silent).synthesize(request)).rejects.toMatchObject({
      code: "synthesis_failed",
      message: expect.stringContaining("no audio"),
    });
  });

  it("maps timeouts and aborts", async () => {
    await expect(engineWith(timedOut).synthesize(request)).rejects.toMatchObject({
      code: "timeout",
    });
    await expect(engineWith(aborted).synthesize(request)).rejects.toMatchObject({
      code: "aborted",
    });
  });

  it("rejects unknown voices and oversized text without running anything", async () => {
    const run = vi.fn<ProcessRunner>();
    const engine = engineWith(run);

    await expect(engine.synthesize({ ...request, voiceId: "other" })).rejects.toMatchObject({
      code: "voice_not_found",
    });
    await expect(
      engine.synthesize({ ...request, text: "x".repeat(engine.maxInputChars + 1) }),
    ).rejects.toMatchObject({ code: "synthesis_failed" });
    expect(run).not.toHaveBeenCalled();
  });

  it("works against a real child process", async () => {
    // A stand-in `piper`: echoes stdin length as one 16-bit sample per input byte.
    const script = path.join(voicesDir, "fake-piper.mjs");
    fs.writeFileSync(
      script,
      `#!/usr/bin/env node
let n = 0;
process.stdin.on("data", (d) => (n += d.length));
process.stdin.on("end", () => process.stdout.write(Buffer.alloc(n * 2, 1)));
`,
      { mode: 0o755 },
    );
    const engine = new PiperEngine({ bin: script, voicesDir });

    const pcm = await engine.synthesize(request);

    expect(pcm.samples.length).toBe("Hello world.\n".length * 2);
  });
});
