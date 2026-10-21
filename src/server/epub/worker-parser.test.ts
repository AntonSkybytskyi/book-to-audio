import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { zipEpub, xhtml, CONTAINER_XML } from "./testing/build-epub.js";
import { lighthouseBook } from "./testing/sample-books.js";
import { EpubError } from "./errors.js";
import { createWorkerParser, ParserBusyError } from "./worker-parser.js";

// The worker runs the TypeScript source through tsx, as `pnpm dev` does.
const execArgv = ["--import", "tsx"];

describe("createWorkerParser", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-parser-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, data: Buffer | string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    return file;
  };

  const scriptWorker = (body: string) => pathToUrl(write("worker.mjs", body));

  it("parses a file in a worker thread and brings the cover back as a Buffer", async () => {
    const parse = createWorkerParser({ execArgv });

    const book = await parse(write("book.epub", await lighthouseBook()));

    expect(book.title).toBe("The Lighthouse Keeper's Almanac");
    expect(book.chapters).toHaveLength(4);
    expect(Buffer.isBuffer(book.cover?.bytes)).toBe(true);
    expect(book.cover?.bytes.subarray(1, 4).toString()).toBe("PNG");
  });

  it("passes typed errors through", async () => {
    const parse = createWorkerParser({ execArgv });
    const drm = await zipEpub({ "META-INF/rights.xml": "<rights/>" });

    const error = await parse(write("drm.epub", drm)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EpubError);
    expect(error).toMatchObject({ code: "drm" });
  });

  it("rejects an element bomb as unsafe_archive without taking the process down", async () => {
    const bomb = await zipEpub({
      "META-INF/container.xml": CONTAINER_XML,
      "OEBPS/content.opf": `<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`,
      "OEBPS/a.xhtml": xhtml("<i/>".repeat(2_000_000)),
    });
    expect(bomb.length).toBeLessThan(100_000);
    const parse = createWorkerParser({ execArgv });

    await expect(parse(write("bomb.epub", bomb))).rejects.toMatchObject({ code: "unsafe_archive" });
  });

  it("maps a worker that runs out of memory to unsafe_archive", async () => {
    const parse = createWorkerParser({
      maxOldGenerationSizeMb: 32,
      workerUrl: scriptWorker(`const keep = []; for (;;) keep.push(new Array(100000).fill("x"));`),
    });

    await expect(parse("/ignored")).rejects.toMatchObject({
      code: "unsafe_archive",
      message: expect.stringContaining("too large or too complex"),
    });
  });

  it("maps a worker that takes too long to unsafe_archive", async () => {
    const parse = createWorkerParser({
      timeoutMs: 100,
      workerUrl: scriptWorker(`setInterval(() => {}, 1000);`),
    });

    await expect(parse("/ignored")).rejects.toMatchObject({ code: "unsafe_archive" });
  });

  it("reports a worker that dies without an answer", async () => {
    const parse = createWorkerParser({ workerUrl: scriptWorker(`process.exit(3);`) });

    await expect(parse("/ignored")).rejects.toThrow(/stopped unexpectedly/);
  });

  it("parses one file at a time and refuses when too many are waiting", async () => {
    const parse = createWorkerParser({
      maxQueued: 1,
      timeoutMs: 1000,
      workerUrl: scriptWorker(`setTimeout(() => {}, 150);`),
    });

    const first = parse("/a").catch((e: unknown) => e);
    const second = parse("/b").catch((e: unknown) => e);
    const third = await parse("/c").catch((e: unknown) => e);

    expect(third).toBeInstanceOf(ParserBusyError);
    // The first two end in "stopped unexpectedly" (the stub never answers), one after the other.
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    // After they finish the parser accepts work again instead of staying stuck.
    expect(await parse("/d").catch((e: unknown) => e)).not.toBeInstanceOf(ParserBusyError);
  });
});

function pathToUrl(file: string) {
  return new URL(`file://${file}`);
}
