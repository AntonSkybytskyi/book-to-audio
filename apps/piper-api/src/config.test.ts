import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_WORKERS } from "@book-to-audio/contracts";
import { describe, expect, it } from "vitest";
import { isExecutable } from "./binary.js";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("has defaults for everything", () => {
    expect(loadConfig({}, 8)).toMatchObject({
      host: "127.0.0.1",
      port: 5000,
      piperBin: "piper",
      voicesDir: "/opt/piper-voices",
      concurrency: 4,
      timeoutMs: 120_000,
      startupGraceMs: 60_000,
      idleMs: 60_000,
      maxInputChars: 1000,
    });
  });

  it("handles at least one request at a time on a single core", () => {
    expect(loadConfig({}, 1).concurrency).toBe(1);
  });

  it("reads the environment, an empty value meaning the default", () => {
    const config = loadConfig(
      {
        HOST: "0.0.0.0",
        PORT: "5001",
        PIPER_BIN: "/usr/local/bin/piper",
        PIPER_VOICES_DIR: "voices",
        PIPER_CONCURRENCY: "",
        MAX_INPUT_CHARS: "500",
        SCRATCH_DIR: "/tmp/piper",
      },
      8,
    );

    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 5001,
      piperBin: "/usr/local/bin/piper",
      voicesDir: path.resolve("voices"),
      concurrency: 4,
      maxInputChars: 500,
      scratchDir: "/tmp/piper",
    });
  });

  it("uses half the cores at once, at most as many as the app runs workers", () => {
    expect(loadConfig({}, 8).concurrency).toBe(4);
    expect(loadConfig({}, 1).concurrency).toBe(1);
    expect(loadConfig({}, 512).concurrency).toBe(MAX_WORKERS);
  });

  it.each([
    ["PORT", "0"],
    ["PIPER_CONCURRENCY", "0"],
    ["PIPER_CONCURRENCY", "two"],
    ["PIPER_CONCURRENCY", String(MAX_WORKERS + 1)],
    ["MAX_INPUT_CHARS", "1.5"],
  ])("rejects %s=%j", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });
});

describe("isExecutable", () => {
  it("finds a name on PATH or a path, and only executable files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "binary-test-"));
    try {
      fs.writeFileSync(path.join(dir, "tool"), "#!/bin/sh\n", { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "data"), "", { mode: 0o644 });

      expect(isExecutable("tool", dir)).toBe(true);
      expect(isExecutable(path.join(dir, "tool"), "")).toBe(true);
      expect(isExecutable("data", dir)).toBe(false);
      expect(isExecutable("missing", dir)).toBe(false);
      expect(isExecutable(dir, "")).toBe(false); // a directory
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
