import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../app.js";
import { OutputError } from "../outputs/errors.js";
import { settled, useOutputsHarness } from "../testing/outputs-harness.js";

interface BookJson {
  outputs: {
    state: string;
    available: boolean;
    updating: boolean;
    m4bBytes: number | null;
    zipBytes: number | null;
  };
}

const url = (id: string, rest: string) => `/api/books/${id}${rest}`;

describe("download routes", () => {
  const h = useOutputsHarness();
  let app: FastifyInstance;

  beforeEach(() => {
    h.producer.hold = false;
    h.builder.start();
    app = buildServer({
      db: h.ctx.db,
      nextHandler: async (_req, res) => {
        res.end();
      },
      storage: h.ctx.storage,
      engine: h.ctx.engine,
      maxUploadBytes: 1024 * 1024,
      bus: h.ctx.bus,
      pool: h.ctx.pool,
      outputs: h.builder,
      settings: h.ctx.settings,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (id: string) => app.inject({ method: "POST", url: url(id, "/outputs/rebuild") });
  const outputsEvents = (id: string) =>
    h.events.flatMap((e) => (e.type === "outputs" && e.bookId === id ? [e] : []));
  const build = async (id: string) => {
    h.builder.request(id);
    await settled(() => h.state(id) === "ready");
  };
  const rename = (id: string, title: string, author: string | null) =>
    h.ctx.db.prepare("UPDATE books SET title = ?, author = ? WHERE id = ?").run(title, author, id);

  it("serves the M4B with its type, an attachment name, an ETag and the whole file", async () => {
    const id = h.addDoneBook();
    rename(id, "Field Notes on Rain", "M. Okafor");
    await build(id);

    const res = await app.inject({ url: url(id, "/downloads/m4b") });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mp4");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="Field Notes on Rain - M. Okafor.m4b"; filename*=UTF-8''Field%20Notes%20on%20Rain%20-%20M.%20Okafor.m4b`,
    );
    expect(res.headers.etag).toBeTruthy();
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.body).toBe("m4b #1");
  });

  it("serves the ZIP under the (WebM) name", async () => {
    const id = h.addDoneBook();
    rename(id, "Book", "Ann");
    await build(id);

    const res = await app.inject({ url: url(id, "/downloads/zip") });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toContain('filename="Book - Ann (WebM).zip"');
    expect(res.body).toBe("zip #1");
  });

  it("names a download after a non-ASCII title with a transliterated ASCII fallback and a UTF-8 name", async () => {
    const id = h.addDoneBook();
    rename(id, "Тіні забутих предків", "Коцюбинський");
    await build(id);

    const res = await app.inject({ url: url(id, "/downloads/m4b") });

    const header = String(res.headers["content-disposition"]);
    expect(header).toContain('filename="Tini zabutykh predkiv - Kotsiubynskyi.m4b"');
    const zip = await app.inject({ url: url(id, "/downloads/zip") });
    expect(String(zip.headers["content-disposition"])).toContain(
      'filename="Tini zabutykh predkiv - Kotsiubynskyi (WebM).zip"',
    );
    expect(header).toContain(
      `filename*=UTF-8''${encodeURIComponent("Тіні забутих предків - Коцюбинський.m4b")}`,
    );
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1] ?? "")).toBe(
      "Тіні забутих предків - Коцюбинський.m4b",
    );
  });

  it("supports Range requests and conditional requests", async () => {
    const id = h.addDoneBook();
    await build(id);

    const part = await app.inject({
      url: url(id, "/downloads/m4b"),
      headers: { range: "bytes=1-2" },
    });
    const full = await app.inject({ url: url(id, "/downloads/m4b") });
    const same = await app.inject({
      url: url(id, "/downloads/m4b"),
      headers: { "if-none-match": String(full.headers.etag) },
    });

    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 1-2/6");
    expect(part.body).toBe("4b");
    expect(same.statusCode).toBe(304);
  });

  it("answers 409 until the files are current, with a reason for each state", async () => {
    const id = h.addDoneBook();

    const preparing = await app.inject({ url: url(id, "/downloads/m4b") });
    expect(preparing.statusCode).toBe(409);
    expect(preparing.json()).toEqual({
      error: "not_ready",
      message: "The downloads are still being prepared.",
    });

    await build(id);
    h.rewriteChapter(id, 1); // a chapter was written: the files are older than the audio
    const stale = await app.inject({ url: url(id, "/downloads/zip") });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().message).toBe("The downloads are being updated after a chapter changed.");

    h.ctx.db.prepare("UPDATE books SET status = 'converting' WHERE id = ?").run(id);
    const converting = await app.inject({ url: url(id, "/downloads/m4b") });
    expect(converting.json().message).toBe("The downloads are ready when every chapter is done.");
  });

  it("never serves files of a book that is done_with_errors", async () => {
    const id = h.addDoneBook();
    await build(id);
    h.ctx.db.prepare("UPDATE books SET status = 'done_with_errors' WHERE id = ?").run(id);

    expect((await app.inject({ url: url(id, "/downloads/m4b") })).statusCode).toBe(409);
    expect((await app.inject({ url: url(id, "/downloads/zip") })).statusCode).toBe(409);
  });

  it("answers 409 after a failed build, 404 for a missing book and 400 for a bad id", async () => {
    const id = h.addDoneBook();
    h.outputs.enqueue(id);
    h.outputs.fail(id, "Chapter 2 has no audio.");

    const failed = await app.inject({ url: url(id, "/downloads/m4b") });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().message).toBe(
      "The downloads could not be built. Try building them again.",
    );
    expect(
      (await app.inject({ url: url("00000000-0000-4000-8000-000000000000", "/downloads/m4b") }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ url: url("nope", "/downloads/zip") })).statusCode).toBe(400);
  });

  it("builds again, instead of failing for good, when a recorded file is gone from the disk", async () => {
    const id = h.addDoneBook();
    await build(id);
    await settled(() => !h.builder.isBusy(id));
    await settled(() => h.files(id).length === 2);
    fs.rmSync(h.ctx.storage.outputFile(id, "m4b"));
    h.producer.hold = true;

    const res = await app.inject({ url: url(id, "/downloads/m4b") });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe("The file is missing. It is being built again.");
    // The page is told at once: no dead links, nothing "still good" to fall back on.
    const view = (await app.inject({ url: url(id, "") })).json<BookJson>();
    expect(view.outputs).toMatchObject({
      available: false,
      updating: false,
      m4bBytes: null,
      zipBytes: null,
    });
    expect(h.repo.get(id)?.outputs?.builtGeneration).toBeNull();
    expect(outputsEvents(id).at(-1)).toMatchObject({ available: false });
    // Still not offered while it is rebuilt, with an honest reason, and the other file is not offered either.
    const again = await app.inject({ url: url(id, "/downloads/zip") });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toBe("The downloads are still being prepared.");

    await settled(() => h.producer.isRunning(id));
    h.producer.release(id);
    await settled(() => h.state(id) === "ready");
    expect((await app.inject({ url: url(id, "/downloads/m4b") })).statusCode).toBe(200);
  });

  it("does not keep calling a failed rebuild of missing files good", async () => {
    const id = h.addDoneBook();
    await build(id);
    await settled(() => !h.builder.isBusy(id));
    await settled(() => h.files(id).length === 2);
    fs.rmSync(h.ctx.storage.outputFile(id, "zip"));
    h.producer.hold = true;
    await app.inject({ url: url(id, "/downloads/zip") });
    await settled(() => h.producer.isRunning(id));

    h.producer.failWith(id, new OutputError("Chapter 2 is incomplete."));
    await settled(() => h.state(id) === "failed");

    const view = (await app.inject({ url: url(id, "") })).json<BookJson>();
    expect(view.outputs).toMatchObject({
      state: "failed",
      available: false,
      error: "Chapter 2 is incomplete.",
    });
  });

  describe("book view", () => {
    it("carries the downloads state, progress and sizes", async () => {
      const id = h.addDoneBook();
      const before = (await app.inject({ url: url(id, "") })).json<BookJson>();
      await build(id);
      const after = (await app.inject({ url: url(id, "") })).json<BookJson>();
      const list = (await app.inject({ url: "/api/books" })).json<{ books: BookJson[] }>();

      expect(before.outputs).toMatchObject({ state: "none", available: false, updating: false });
      expect(after.outputs).toMatchObject({
        state: "ready",
        available: true,
        m4bBytes: 6,
        zipBytes: 6,
      });
      expect(list.books[0]?.outputs.available).toBe(true);
    });

    it("says updating once the audio moved on", async () => {
      const id = h.addDoneBook();
      await build(id);
      h.rewriteChapter(id, 2);

      const view = (await app.inject({ url: url(id, "") })).json<BookJson>();

      expect(view.outputs).toMatchObject({
        state: "ready",
        available: false,
        updating: true,
        m4bBytes: null,
        zipBytes: null,
      });
    });
  });

  describe("POST outputs/rebuild", () => {
    it("retries a failed build", async () => {
      const id = h.addDoneBook();
      h.outputs.enqueue(id);
      h.outputs.fail(id, "boom");

      const res = await post(id);

      expect(res.statusCode).toBe(200);
      await settled(() => h.state(id) === "ready");
      expect((await app.inject({ url: url(id, "/downloads/m4b") })).statusCode).toBe(200);
    });

    it("forces a rebuild of files that are ready", async () => {
      const id = h.addDoneBook();
      await build(id);
      await settled(() => h.files(id).length === 2);

      const res = await post(id);

      expect(res.statusCode).toBe(200);
      await settled(() => h.producer.started.length === 2 && h.state(id) === "ready");
    });

    it("keeps serving the files while a forced rebuild runs, and after it failed", async () => {
      const id = h.addDoneBook();
      await build(id);
      await settled(() => !h.builder.isBusy(id));
      h.producer.hold = true;

      expect((await post(id)).statusCode).toBe(200);
      await settled(() => h.producer.isRunning(id));
      const during = await app.inject({ url: url(id, "/downloads/m4b") });
      const viewDuring = (await app.inject({ url: url(id, "") })).json<BookJson>();
      h.producer.failWith(id, new OutputError("Chapter 2 is incomplete."));
      await settled(() => h.state(id) === "failed");
      const after = await app.inject({ url: url(id, "/downloads/zip") });
      const viewAfter = (await app.inject({ url: url(id, "") })).json<BookJson>();

      expect(during.statusCode).toBe(200);
      expect(during.body).toBe("m4b #1");
      expect(viewDuring.outputs).toMatchObject({ state: "building", available: true, m4bBytes: 6 });
      expect(after.statusCode).toBe(200);
      expect(after.body).toBe("zip #1");
      expect(viewAfter.outputs).toMatchObject({
        state: "failed",
        available: true,
        error: "Chapter 2 is incomplete.",
      });
    });

    it("answers 409 while a build is queued or running, or when the book is not done", async () => {
      h.producer.hold = true;
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.producer.isRunning(id));

      expect((await post(id)).statusCode).toBe(409);

      const converting = h.addDoneBook();
      h.ctx.db.prepare("UPDATE books SET status = 'converting' WHERE id = ?").run(converting);
      expect((await post(converting)).statusCode).toBe(409);
    });

    it("answers 404 and 400", async () => {
      expect((await post("00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
      expect((await post("nope")).statusCode).toBe(400);
    });

    it("refuses a request from another origin like every other POST", async () => {
      const id = h.addDoneBook();
      const res = await app.inject({
        method: "POST",
        url: url(id, "/outputs/rebuild"),
        headers: { origin: "http://evil.example" },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
