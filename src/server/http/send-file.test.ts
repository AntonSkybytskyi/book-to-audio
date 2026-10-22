import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendFile } from "./send-file.js";

describe("sendFile", () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "send-file-"));
    fs.writeFileSync(path.join(dir, "a.bin"), "0123456789");
    app = Fastify();
    app.get("/f/:name", (req, reply) =>
      sendFile(req, reply, path.join(dir, (req.params as { name: string }).name), "audio/mp4"),
    );
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends the whole file with its length, type and ETag", async () => {
    const res = await app.inject({ url: "/f/a.bin" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("0123456789");
    expect(res.headers["content-length"]).toBe("10");
    expect(res.headers["content-type"]).toBe("audio/mp4");
    expect(res.headers.etag).toMatch(/^"a-/);
  });

  it("sends a range, answers 304 for a matching ETag and 416 past the end", async () => {
    const full = await app.inject({ url: "/f/a.bin" });
    const part = await app.inject({ url: "/f/a.bin", headers: { range: "bytes=2-4" } });
    const same = await app.inject({
      url: "/f/a.bin",
      headers: { "if-none-match": String(full.headers.etag) },
    });
    const past = await app.inject({ url: "/f/a.bin", headers: { range: "bytes=50-60" } });

    expect([part.statusCode, part.body, part.headers["content-range"]]).toEqual([
      206,
      "234",
      "bytes 2-4/10",
    ]);
    expect(same.statusCode).toBe(304);
    expect(past.statusCode).toBe(416);
  });

  it("gives the whole new file to a resume of an older version (If-Range with another ETag)", async () => {
    const res = await app.inject({
      url: "/f/a.bin",
      headers: { range: "bytes=2-4", "if-range": '"old"' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("0123456789");
  });

  it("answers 404 for a missing file and for a directory", async () => {
    fs.mkdirSync(path.join(dir, "d"));

    expect((await app.inject({ url: "/f/nope" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/f/d" })).statusCode).toBe(404);
  });

  it("takes the size and the bytes from the same open file, so a rename in between changes neither", async () => {
    const file = path.join(dir, "big.bin");
    fs.writeFileSync(file, "old".repeat(1000));
    const open = fsp.open.bind(fsp);
    // The file is replaced the moment after it was opened, before anything is read from it.
    vi.spyOn(fsp, "open").mockImplementationOnce(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      fs.writeFileSync(`${file}.new`, "a-completely-different-and-longer-replacement".repeat(1000));
      fs.renameSync(`${file}.new`, file);
      return handle;
    });

    const res = await app.inject({ url: "/f/big.bin" });

    expect(res.body).toBe("old".repeat(1000));
    expect(res.headers["content-length"]).toBe(String(3000));
  });

  it("closes the file when it answers 304 or 416", async () => {
    const closed: number[] = [];
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closed.push(handle.fd);
        return close();
      };
      return handle;
    });
    const full = await app.inject({ url: "/f/a.bin" });

    await app.inject({ url: "/f/a.bin", headers: { "if-none-match": String(full.headers.etag) } });
    await app.inject({ url: "/f/a.bin", headers: { range: "bytes=50-60" } });

    expect(closed).toHaveLength(3); // the full answer closes when its stream ends
  });
});
