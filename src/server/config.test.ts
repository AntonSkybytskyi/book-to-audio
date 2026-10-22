import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("listens on localhost:3000 with ./data by default", () => {
    const config = loadConfig({});

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3000);
    expect(config.dataDir).toBe(path.resolve("data"));
    expect(config.dev).toBe(false);
  });

  it("runs Next in dev mode only when NODE_ENV=development", () => {
    expect(loadConfig({ NODE_ENV: "development" }).dev).toBe(true);
    expect(loadConfig({ NODE_ENV: "prod" }).dev).toBe(false);
  });

  it("reads HOST, PORT, DATA_DIR and NODE_ENV", () => {
    const config = loadConfig({
      HOST: "0.0.0.0",
      PORT: "8080",
      DATA_DIR: "/data",
      NODE_ENV: "production",
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
    expect(config.dataDir).toBe("/data");
    expect(config.dev).toBe(false);
  });

  it("resolves a relative DATA_DIR to an absolute path", () => {
    expect(loadConfig({ DATA_DIR: "tmp/books" }).dataDir).toBe(path.resolve("tmp/books"));
  });

  it.each(["abc", "0", "65536", "80.5", ""])("rejects PORT=%j", (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow(/PORT/);
  });

  it("uses Piper, ffmpeg and a 200 MB upload limit by default", () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      maxUploadMb: 200,
      ttsEngine: "piper",
      piperBin: "piper",
      piperVoicesDir: "/opt/piper-voices",
      ffmpegBin: "ffmpeg",
      ffprobeBin: "ffprobe",
      opusBitrate: "32k",
      m4bBitrate: "64k",
      fakeTtsDelayMs: 0,
      allowedHosts: [],
      workers: undefined,
      minFreeDiskMb: 500,
      fakeTtsFailMarker: undefined,
      fakeTtsFlakyMarker: undefined,
      fakeTtsBadMarker: undefined,
    });
  });

  it("reads the free-space margin and rejects nonsense", () => {
    expect(loadConfig({ MIN_FREE_DISK_MB: "2048" }).minFreeDiskMb).toBe(2048);
    expect(loadConfig({ MIN_FREE_DISK_MB: "0" }).minFreeDiskMb).toBe(0);
    expect(() => loadConfig({ MIN_FREE_DISK_MB: "lots" })).toThrow(/MIN_FREE_DISK_MB/);
  });

  it("reads the worker count and the fake engine failure markers", () => {
    const config = loadConfig({
      WORKERS: "3",
      FAKE_TTS_FAIL_MARKER: "[fail]",
      FAKE_TTS_FLAKY_MARKER: "[flaky]",
      FAKE_TTS_BAD_MARKER: "[bad]",
    });

    expect(config).toMatchObject({
      workers: 3,
      fakeTtsFailMarker: "[fail]",
      fakeTtsFlakyMarker: "[flaky]",
      fakeTtsBadMarker: "[bad]",
    });
  });

  it.each(["0", "-1", "two", "1.5", "999"])("rejects WORKERS=%s", (value) => {
    expect(() => loadConfig({ WORKERS: value })).toThrow(/WORKERS/);
  });

  it("treats empty WORKERS and markers as unset", () => {
    expect(loadConfig({ WORKERS: "", FAKE_TTS_FAIL_MARKER: "" })).toMatchObject({
      workers: undefined,
      fakeTtsFailMarker: undefined,
    });
  });

  it("reads the upload, TTS and audio settings", () => {
    const config = loadConfig({
      MAX_UPLOAD_MB: "5",
      TTS_ENGINE: "fake",
      PIPER_BIN: "/opt/piper/piper",
      PIPER_VOICES_DIR: "/voices",
      FFMPEG_BIN: "/usr/bin/ffmpeg",
      FFPROBE_BIN: "/usr/bin/ffprobe",
      OPUS_BITRATE: "48k",
      M4B_BITRATE: "96k",
      FAKE_TTS_DELAY_MS: "250",
      ALLOWED_HOSTS: "Books.lan, nas.local,,",
    });

    expect(config).toMatchObject({
      maxUploadMb: 5,
      ttsEngine: "fake",
      piperBin: "/opt/piper/piper",
      piperVoicesDir: "/voices",
      ffmpegBin: "/usr/bin/ffmpeg",
      ffprobeBin: "/usr/bin/ffprobe",
      opusBitrate: "48k",
      m4bBitrate: "96k",
      fakeTtsDelayMs: 250,
      allowedHosts: ["books.lan", "nas.local"],
    });
  });

  it("treats empty numeric settings as unset", () => {
    expect(loadConfig({ MAX_UPLOAD_MB: "", FAKE_TTS_DELAY_MS: "" })).toMatchObject({
      maxUploadMb: 200,
      fakeTtsDelayMs: 0,
    });
  });

  it.each([
    { MAX_UPLOAD_MB: "0" },
    { MAX_UPLOAD_MB: "lots" },
    { TTS_ENGINE: "espeak" },
    { OPUS_BITRATE: "32" },
    { M4B_BITRATE: "64" },
    { FAKE_TTS_DELAY_MS: "-1" },
  ])("rejects %j", (env) => {
    expect(() => loadConfig(env)).toThrow(/Invalid/);
  });
});
