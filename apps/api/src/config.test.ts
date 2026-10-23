import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

/** The environment with the one setting that has no default. */
const load = (env: Record<string, string | undefined> = {}) =>
  loadConfig({ TTS_SERVICES: "piper=http://piper-api:5000", ...env });

describe("loadConfig", () => {
  it("listens on localhost:3000 with ./data by default", () => {
    const config = load();

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3000);
    expect(config.dataDir).toBe(path.resolve("data"));
  });

  it("reads HOST, PORT and DATA_DIR", () => {
    const config = load({
      HOST: "0.0.0.0",
      PORT: "8080",
      DATA_DIR: "/data",
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
    expect(config.dataDir).toBe("/data");
  });

  it("resolves a relative DATA_DIR to an absolute path", () => {
    expect(load({ DATA_DIR: "tmp/books" }).dataDir).toBe(path.resolve("tmp/books"));
  });

  it.each(["abc", "0", "65536", "80.5", ""])("rejects PORT=%j", (port) => {
    expect(() => load({ PORT: port })).toThrow(/PORT/);
  });

  it("uses ffmpeg, a 200 MB upload limit and a 10 minute TTS request timeout by default", () => {
    expect(load()).toMatchObject({
      maxUploadMb: 200,
      ttsRequestTimeoutMs: 600_000,
      ffmpegBin: "ffmpeg",
      ffprobeBin: "ffprobe",
      opusBitrate: "32k",
      m4bBitrate: "64k",
      allowedHosts: [],
      minFreeDiskMb: 500,
    });
  });

  it("reads the free-space margin and rejects nonsense", () => {
    expect(load({ MIN_FREE_DISK_MB: "2048" }).minFreeDiskMb).toBe(2048);
    expect(load({ MIN_FREE_DISK_MB: "0" }).minFreeDiskMb).toBe(0);
    expect(() => load({ MIN_FREE_DISK_MB: "lots" })).toThrow(/MIN_FREE_DISK_MB/);
  });

  describe("TTS_SERVICES", () => {
    it("lists the services in order, without trailing slashes", () => {
      const config = load({
        TTS_SERVICES: " piper=http://piper-api:5000/ , qwen_3=https://tts.lan:8443/api ",
      });

      expect(config.ttsServices).toEqual([
        { name: "piper", url: "http://piper-api:5000" },
        { name: "qwen_3", url: "https://tts.lan:8443/api" },
      ]);
    });

    it("keeps an equals sign inside the url", () => {
      expect(load({ TTS_SERVICES: "a=http://h/?x=1" }).ttsServices).toEqual([
        { name: "a", url: "http://h/?x=1" },
      ]);
    });

    it.each(["", "   "])("is required (%j)", (value) => {
      expect(() => loadConfig({ TTS_SERVICES: value })).toThrow(/TTS_SERVICES is not set/);
      expect(() => loadConfig({})).toThrow(/TTS_SERVICES is not set/);
    });

    it.each([
      ["no name", "=http://h"],
      ["a colon in the name", "pi:per=http://h"],
      ["upper case", "Piper=http://h"],
      ["no url", "piper"],
      ["not a url", "piper=piper-api:5000x"],
      ["another protocol", "piper=ftp://h"],
      ["a name twice", "piper=http://a,piper=http://b"],
      ["an empty entry", "piper=http://a,"],
    ])("rejects %s", (_name, value) => {
      expect(() => loadConfig({ TTS_SERVICES: value })).toThrow(/TTS_SERVICES/);
    });
  });

  it("reads the upload, TTS and audio settings", () => {
    const config = load({
      MAX_UPLOAD_MB: "5",
      TTS_REQUEST_TIMEOUT_MS: "60000",
      FFMPEG_BIN: "/usr/bin/ffmpeg",
      FFPROBE_BIN: "/usr/bin/ffprobe",
      OPUS_BITRATE: "48k",
      M4B_BITRATE: "96k",
      ALLOWED_HOSTS: "Books.lan, nas.local,,",
    });

    expect(config).toMatchObject({
      maxUploadMb: 5,
      ttsRequestTimeoutMs: 60_000,
      ffmpegBin: "/usr/bin/ffmpeg",
      ffprobeBin: "/usr/bin/ffprobe",
      opusBitrate: "48k",
      m4bBitrate: "96k",
      allowedHosts: ["books.lan", "nas.local"],
    });
  });

  it("treats empty numeric settings as unset", () => {
    expect(load({ MAX_UPLOAD_MB: "", TTS_REQUEST_TIMEOUT_MS: "" })).toMatchObject({
      maxUploadMb: 200,
      ttsRequestTimeoutMs: 600_000,
    });
  });

  it.each([
    { MAX_UPLOAD_MB: "0" },
    { MAX_UPLOAD_MB: "lots" },
    { TTS_REQUEST_TIMEOUT_MS: "10" },
    { OPUS_BITRATE: "32" },
    { M4B_BITRATE: "64" },
  ])("rejects %j", (env) => {
    expect(() => load(env)).toThrow(/Invalid/);
  });
});
