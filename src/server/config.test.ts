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
});
