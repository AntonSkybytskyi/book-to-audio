import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../app.js";
import { ChapterQueue } from "../books/queue.js";
import type { AppEvent } from "../events/bus.js";
import { EpubError } from "../epub/errors.js";
import { zipEpub } from "../epub/testing/build-epub.js";
import { ParserBusyError } from "../epub/worker-parser.js";
import { lighthouseBook, rainBook } from "../epub/testing/sample-books.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { multipartBody } from "../testing/multipart.js";

interface ChapterJson {
  position: number;
  title: string;
  status: string;
}
interface BookJson {
  id: string;
  title: string;
  status: string;
  language: string;
  hasCover: boolean;
  chapters: ChapterJson[];
  availableLanguages: string[];
}

describe("book routes", () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  let queued = 0;

  const buildApp = (maxUploadBytes = 5 * 1024 * 1024, parseEpub = ctx.parseEpub) =>
    buildServer({
      db: ctx.db,
      storage: ctx.storage,
      engine: ctx.engine,
      maxUploadBytes,
      parseEpub,
      bus: ctx.bus,
      pool: ctx.pool,
      outputs: ctx.outputs,
      settings: ctx.settings,
    });

  const upload = (filename: string, data: Buffer | string) =>
    app.inject({ method: "POST", url: "/api/books", ...multipartBody([{ filename, data }]) });

  it("tells listeners about a new book", async () => {
    const seen: AppEvent[] = [];
    ctx.bus.subscribe((event) => seen.push(event));

    const res = await upload("lighthouse.epub", await lighthouseBook());

    const bookId = res.json<BookJson>().id;
    expect(seen[0]).toEqual({ type: "book-added", bookId });
    // The text is counted after the answer; that is told as well (and not before the book was announced).
    await vi.waitFor(() => expect(seen).toContainEqual({ type: "book-counted", bookId }));
  });

  it("tells nobody about an upload that failed", async () => {
    const seen: AppEvent[] = [];
    ctx.bus.subscribe((event) => seen.push(event));

    await upload("broken.epub", "not a zip");

    expect(seen).toEqual([]);
  });

  const uploadLighthouse = async () => {
    const res = await upload("lighthouse.epub", await lighthouseBook());
    expect(res.statusCode).toBe(201);
    return res.json<BookJson>();
  };

  beforeEach(() => {
    ctx = createTestContext();
    queued = 0;
    vi.spyOn(ctx.pool, "notify").mockImplementation(() => {
      queued++;
    });
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
    ctx.cleanup();
  });

  describe("POST /api/books", () => {
    it("stores the book and answers with chapters but no text", async () => {
      const res = await upload("lighthouse.epub", await lighthouseBook());

      expect(res.statusCode).toBe(201);
      const book = res.json<BookJson & { chapters: Record<string, unknown>[] }>();
      expect(book).toMatchObject({
        title: "The Lighthouse Keeper's Almanac",
        status: "ready",
        language: "en",
        hasCover: true,
        availableLanguages: ["en"],
      });
      expect(book.chapters).toHaveLength(4);
      expect(book.chapters[0]).toMatchObject({
        position: 1,
        title: "The Last Boat",
        status: "pending",
        preparedChars: expect.any(Number),
        estimatedSeconds: null, // not counted yet: the upload does not wait for it
      });
      expect(JSON.stringify(book)).not.toContain("supply boat");
      expect(JSON.stringify(book)).not.toContain(ctx.dataDir);
    });

    it("keeps the source file and cover under the data directory", async () => {
      const book = await uploadLighthouse();

      const dir = path.join(ctx.dataDir, "books", book.id);
      expect(fs.readdirSync(dir).toSorted()).toEqual(["cover.png", "source.epub"]);
    });

    it("maps en-GB to English and unknown languages to English", async () => {
      const res = await upload("rain.epub", await rainBook());

      expect(res.json<BookJson>().language).toBe("en");
    });

    it("rejects other file types with 415", async () => {
      const res = await upload("notes.pdf", "%PDF-1.7");

      expect(res.statusCode).toBe(415);
      expect(res.json()).toMatchObject({ error: "unsupported_type" });
    });

    it("rejects a request that is not multipart with 415", async () => {
      const res = await app.inject({ method: "POST", url: "/api/books", payload: { a: 1 } });

      expect(res.statusCode).toBe(415);
      expect(res.json()).toMatchObject({ error: "unsupported_type" });
    });

    it("rejects a multipart request without a file with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/books",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        payload: "--x--\r\n",
      });

      expect(res.statusCode).toBe(400);
    });

    it("requires the file to be in a field named file", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/books",
        ...multipartBody([{ name: "other", filename: "a.epub", data: await lighthouseBook() }]),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "bad_request" });
      expect(fs.readdirSync(path.join(ctx.dataDir, "books"))).toEqual([]);
    });

    it("answers 429 when too many books are already waiting to be read", async () => {
      await app.close();
      app = buildApp(5 * 1024 * 1024, async () => {
        throw new ParserBusyError();
      });

      const res = await upload("a.epub", await lighthouseBook());

      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: "busy" });
      expect(fs.readdirSync(path.join(ctx.dataDir, "books"))).toEqual([]);
    });

    it("answers 422 for a book with too many chapters", async () => {
      await app.close();
      app = buildApp(5 * 1024 * 1024, async () => {
        throw new EpubError("too_many_chapters", "This EPUB has more than 2000 chapters.");
      });

      const res = await upload("a.epub", await lighthouseBook());

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "too_many_chapters" });
    });

    it("answers 500 without details when the parser itself breaks", async () => {
      await app.close();
      app = buildApp(5 * 1024 * 1024, async () => {
        throw new Error("worker exploded at /secret/path");
      });

      const res = await upload("a.epub", await lighthouseBook());

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain("secret");
      expect(fs.readdirSync(path.join(ctx.dataDir, "books"))).toEqual([]);
    });

    it("answers 422 not_epub for a .epub that is not a zip", async () => {
      const res = await upload("fake.epub", "just some text");

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "not_epub" });
    });

    it("answers 422 drm for protected books", async () => {
      const drm = await zipEpub({ "META-INF/rights.xml": "<rights/>" });

      const res = await upload("drm.epub", drm);

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "drm" });
      expect(res.json<{ message: string }>().message).toMatch(/DRM/);
    });

    it("answers 413 for a file over the limit and leaves nothing behind", async () => {
      await app.close();
      app = buildApp(2000);

      const res = await upload("big.epub", Buffer.alloc(50_000, 1));

      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({ error: "too_large" });
      expect(fs.readdirSync(path.join(ctx.dataDir, "books"))).toEqual([]);
      expect(ctx.db.prepare("SELECT count(*) FROM books").pluck().get()).toBe(0);
    });

    it("cleans up files when parsing fails", async () => {
      await upload("fake.epub", "nope");

      expect(fs.readdirSync(path.join(ctx.dataDir, "books"))).toEqual([]);
    });
  });

  describe("GET /api/config", () => {
    it("tells the UI the upload limit", async () => {
      await app.close();
      app = buildApp(3 * 1024 * 1024);

      const res = await app.inject({ url: "/api/config" });

      expect(res.json()).toEqual({ maxUploadMb: 3 });
    });
  });

  describe("security", () => {
    it("sets protective headers on API responses, including errors and files", async () => {
      const book = await uploadLighthouse();

      for (const url of [
        "/api/books",
        `/api/books/${book.id}/cover`,
        "/api/books/nope",
        "/api/nothing",
      ]) {
        const res = await app.inject({ url });
        expect(res.headers).toMatchObject({
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        });
      }
    });

    it("refuses requests for another Host", async () => {
      const res = await app.inject({ url: "/api/books", headers: { host: "evil.example" } });

      expect(res.statusCode).toBe(403);
    });

    it("refuses a cross-site upload and stores nothing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/books",
        ...multipartBody([{ filename: "a.epub", data: await lighthouseBook() }]),
        headers: {
          ...multipartBody([]).headers,
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
      });

      expect(res.statusCode).toBe(403);
      expect(fs.readdirSync(path.join(ctx.dataDir, "books"))).toEqual([]);
    });

    it("accepts an upload from the page itself", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/books",
        ...multipartBody([{ filename: "a.epub", data: await lighthouseBook() }]),
        headers: {
          ...multipartBody([]).headers,
          host: "localhost:3300",
          origin: "http://localhost:3300",
          "sec-fetch-site": "same-origin",
        },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe("reading books", () => {
    it("lists books newest first with totals", async () => {
      await uploadLighthouse();
      await upload("rain.epub", await rainBook());

      const res = await app.inject({ url: "/api/books" });

      const { books } = res.json<{ books: (BookJson & { chapterCount: number })[] }>();
      expect(books.map((b) => b.title)).toEqual([
        "Field Notes on Rain",
        "The Lighthouse Keeper's Almanac",
      ]);
      expect(books[0]?.chapterCount).toBe(3);
    });

    it("answers 400 for an id that is not a UUID and 404 for an unknown one", async () => {
      expect((await app.inject({ url: "/api/books/not-a-uuid" })).statusCode).toBe(400);
      expect((await app.inject({ url: "/api/books/..%2F..%2Fetc" })).statusCode).toBe(400);
      const missing = await app.inject({ url: "/api/books/6f1c1b34-8d5b-4f64-9f0a-5a2d3f0c9d11" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: "not_found" });
    });

    it("serves the cover with a safe content type", async () => {
      const book = await uploadLighthouse();

      const res = await app.inject({ url: `/api/books/${book.id}/cover` });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.rawPayload.subarray(1, 4).toString()).toBe("PNG");
    });

    it("answers 404 when there is no cover", async () => {
      const book = await uploadLighthouse();
      ctx.db
        .prepare("UPDATE books SET cover_path = NULL, cover_mime = NULL WHERE id = ?")
        .run(book.id);

      const res = await app.inject({ url: `/api/books/${book.id}/cover` });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("PATCH /api/books/:id", () => {
    it("changes the language while the book is ready", async () => {
      const book = await uploadLighthouse();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/books/${book.id}`,
        payload: { language: "uk" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json<BookJson>().language).toBe("uk");
    });

    it.each([{ language: "fr" }, {}, { language: 5 }])(
      "rejects body %j with 400",
      async (payload) => {
        const book = await uploadLighthouse();

        const res = await app.inject({ method: "PATCH", url: `/api/books/${book.id}`, payload });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: "bad_request" });
      },
    );

    it("answers 409 once the book has been queued", async () => {
      const book = await uploadLighthouse();
      await app.inject({ method: "POST", url: `/api/books/${book.id}/convert` });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/books/${book.id}`,
        payload: { language: "ru" },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe("POST /api/books/:id/convert", () => {
    it("queues every chapter and wakes the workers", async () => {
      const book = await uploadLighthouse();

      const res = await app.inject({ method: "POST", url: `/api/books/${book.id}/convert` });

      expect(res.statusCode).toBe(202);
      expect(res.json<BookJson>().status).toBe("converting");
      expect(res.json<BookJson>().chapters.map((c) => c.status)).toEqual(Array(4).fill("queued"));
      expect(queued).toBe(1);
      expect(new ChapterQueue(ctx.db).claimNext()).toMatchObject({ bookId: book.id, position: 1 });
    });

    it("makes the book's audio folder, which the workers never create", async () => {
      const book = await uploadLighthouse();
      expect(fs.existsSync(ctx.storage.audioDir(book.id))).toBe(false);

      await app.inject({ method: "POST", url: `/api/books/${book.id}/convert` });

      expect(fs.existsSync(ctx.storage.audioDir(book.id))).toBe(true);
    });

    it("tells listeners that the book started converting", async () => {
      const book = await uploadLighthouse();
      const seen: AppEvent[] = [];
      ctx.bus.subscribe((event) => seen.push(event));

      await app.inject({ method: "POST", url: `/api/books/${book.id}/convert` });

      expect(seen).toEqual([
        {
          type: "book",
          bookId: book.id,
          status: "converting",
          doneCount: 0,
          failedCount: 0,
          durationSeconds: 0,
        },
      ]);
    });

    it("answers 409 when the book is not ready", async () => {
      const book = await uploadLighthouse();
      await app.inject({ method: "POST", url: `/api/books/${book.id}/convert` });

      const res = await app.inject({ method: "POST", url: `/api/books/${book.id}/convert` });

      expect(res.statusCode).toBe(409);
      expect(queued).toBe(1);
    });

    it("answers 422 when the engine has no voice for the language", async () => {
      const book = await uploadLighthouse();
      await app.inject({
        method: "PATCH",
        url: `/api/books/${book.id}`,
        payload: { language: "uk" },
      });

      const res = await app.inject({ method: "POST", url: `/api/books/${book.id}/convert` });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "no_voice" });
      expect(res.json<{ message: string }>().message).toMatch(/Ukrainian/);
      const after = await app.inject({ url: `/api/books/${book.id}` });
      expect(after.json<BookJson>().status).toBe("ready");
    });
  });

  describe("GET /api/books/:id/chapters/:position/audio", () => {
    const AUDIO = Buffer.from("0123456789".repeat(10));

    const bookWithAudio = async () => {
      const book = await uploadLighthouse();
      await app.inject({ method: "POST", url: `/api/books/${book.id}/convert` });
      const queue = new ChapterQueue(ctx.db);
      const task = queue.claimNext();
      if (!task) throw new Error("expected a queued chapter");
      ctx.storage.ensureAudioDir(book.id);
      const rel = ctx.storage.audioRelPath(book.id, task.position);
      fs.writeFileSync(ctx.storage.resolve(rel), AUDIO);
      queue.markDone(task, rel, 12.5);
      return book;
    };

    it("streams the whole file with range support advertised", async () => {
      const book = await bookWithAudio();

      const res = await app.inject({ url: `/api/books/${book.id}/chapters/1/audio` });

      expect(res.statusCode).toBe(200);
      expect(res.headers).toMatchObject({
        "content-type": "audio/webm",
        "accept-ranges": "bytes",
        "content-length": "100",
      });
      expect(res.rawPayload).toEqual(AUDIO);
    });

    it("answers a Range request with 206 and the right headers", async () => {
      const book = await bookWithAudio();

      const res = await app.inject({
        url: `/api/books/${book.id}/chapters/1/audio`,
        headers: { range: "bytes=10-19" },
      });

      expect(res.statusCode).toBe(206);
      expect(res.headers["content-range"]).toBe("bytes 10-19/100");
      expect(res.headers["content-length"]).toBe("10");
      expect(res.rawPayload).toEqual(AUDIO.subarray(10, 20));
    });

    it("supports open ended and suffix ranges", async () => {
      const book = await bookWithAudio();
      const url = `/api/books/${book.id}/chapters/1/audio`;

      const open = await app.inject({ url, headers: { range: "bytes=95-" } });
      const suffix = await app.inject({ url, headers: { range: "bytes=-5" } });

      expect(open.headers["content-range"]).toBe("bytes 95-99/100");
      expect(suffix.rawPayload).toEqual(AUDIO.subarray(95));
    });

    it("answers 416 for a range past the end", async () => {
      const book = await bookWithAudio();

      const res = await app.inject({
        url: `/api/books/${book.id}/chapters/1/audio`,
        headers: { range: "bytes=500-600" },
      });

      expect(res.statusCode).toBe(416);
      expect(res.headers["content-range"]).toBe("bytes */100");
    });

    it("answers 304 when the ETag matches", async () => {
      const book = await bookWithAudio();
      const url = `/api/books/${book.id}/chapters/1/audio`;
      const first = await app.inject({ url });

      const res = await app.inject({
        url,
        headers: { "if-none-match": String(first.headers.etag) },
      });

      expect(res.statusCode).toBe(304);
    });

    it("answers 404 for chapters without audio, unknown chapters and 400 for bad positions", async () => {
      const book = await bookWithAudio();
      const base = `/api/books/${book.id}/chapters`;

      expect((await app.inject({ url: `${base}/2/audio` })).json()).toMatchObject({
        error: "not_ready",
      });
      expect((await app.inject({ url: `${base}/99/audio` })).statusCode).toBe(404);
      expect((await app.inject({ url: `${base}/0/audio` })).statusCode).toBe(400);
      expect((await app.inject({ url: `${base}/abc/audio` })).statusCode).toBe(400);
      expect((await app.inject({ url: `${base}/..%2F1/audio` })).statusCode).toBe(400);
    });
  });
});
