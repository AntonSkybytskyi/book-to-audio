import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareChunks } from "./chapter-text.js";
import { createTextPreparer } from "./text-preparer.js";

// The worker runs the TypeScript source through tsx, as `pnpm dev` does.
const execArgv = ["--import", "tsx"];
/** Starting a worker thread with tsx is slow when the machine is busy. */
const SLOW_START_MS = 30_000;

describe("createTextPreparer", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "text-preparer-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const scriptWorker = (body: string) => {
    const file = path.join(dir, "worker.mjs");
    fs.writeFileSync(file, body);
    return pathToFileURL(file);
  };

  it(
    "gives what preparing in place gives, from a worker thread",
    async () => {
      const prepare = createTextPreparer({ execArgv });
      const text = "У 1999 році було 21 книга.\n\nДалі XIX століття, і т. д. Ще одне речення.";

      const chunks = await prepare(text, "uk", 40);

      expect(chunks).toEqual(prepareChunks(text, "uk", 40));
      expect(chunks.length).toBeGreaterThan(1);
    },
    SLOW_START_MS,
  );

  it("fails a chapter whose text takes too long with bad_input, and stops the thread", async () => {
    const prepare = createTextPreparer({
      baseTimeoutMs: 100,
      workerUrl: scriptWorker(`for (;;) {}`),
    });

    const error = await prepare("text", "uk", 100).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: "bad_input",
      message: expect.stringContaining("could not be prepared for reading in time"),
      detail: expect.stringContaining("longer than"),
    });
  });

  it("fails with bad_input when the thread runs out of memory", async () => {
    const prepare = createTextPreparer({
      maxOldGenerationSizeMb: 32,
      workerUrl: scriptWorker(`const keep = []; for (;;) keep.push(new Array(100000).fill("x"));`),
    });

    await expect(prepare("text", "uk", 100)).rejects.toMatchObject({
      code: "bad_input",
      detail: expect.stringContaining("memory"),
    });
  });

  it("fails with bad_input when the thread dies, and when it reports an error", async () => {
    await expect(
      createTextPreparer({ workerUrl: scriptWorker(`process.exit(3);`) })("t", "en", 10),
    ).rejects.toMatchObject({ code: "bad_input", detail: expect.stringContaining("exit code 3") });
    await expect(
      createTextPreparer({
        workerUrl: scriptWorker(
          `import { parentPort } from "node:worker_threads"; parentPort.postMessage({ ok: false, message: "boom" });`,
        ),
      })("t", "en", 10),
    ).rejects.toMatchObject({ code: "bad_input", detail: "boom" });
  });

  it("gives the thread more time for a longer text", async () => {
    // 100 ms plus a second per 100,000 characters: a chapter this long outlives the base time.
    const prepare = createTextPreparer({
      baseTimeoutMs: 100,
      workerUrl: scriptWorker(
        `import { parentPort } from "node:worker_threads"; setTimeout(() => parentPort.postMessage({ ok: true, chunks: ["done"] }), 400);`,
      ),
    });

    await expect(prepare("x".repeat(100_001), "en", 10)).resolves.toEqual(["done"]);
    await expect(prepare("short", "en", 10)).rejects.toMatchObject({ code: "bad_input" });
  });

  it("stops at once when the conversion is cancelled", async () => {
    const prepare = createTextPreparer({ workerUrl: scriptWorker(`setInterval(() => {}, 1000);`) });
    const controller = new AbortController();

    const outcome = prepare("text", "en", 10, controller.signal).catch((e: unknown) => e);
    controller.abort();

    expect(await outcome).toMatchObject({ code: "aborted" });
    await expect(prepare("text", "en", 10, AbortSignal.abort())).rejects.toMatchObject({
      code: "aborted",
    });
  });
});
