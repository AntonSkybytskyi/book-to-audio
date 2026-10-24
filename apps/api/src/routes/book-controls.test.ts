import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../app.js";
import { ChapterQueue } from "../books/queue.js";
import { BookRepository } from "../books/repository.js";
import type { AppEvent } from "../events/bus.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { LANGUAGES } from "../books/languages.js";

interface BookJson {
  id: string;
  status: string;
  doneCount: number;
  chapters: { position: number; status: string; hasAudio: boolean; audioVersion: number }[];
}

const url = (id: string, rest = "") => `/api/books/${id}${rest}`;

const calls = (id: string): { method: "POST" | "DELETE"; url: string }[] => [
  { method: "POST", url: url(id, "/pause") },
  { method: "POST", url: url(id, "/resume") },
  { method: "POST", url: url(id, "/regenerate") },
  { method: "POST", url: url(id, "/chapters/1/regenerate") },
  { method: "DELETE", url: url(id) },
];

describe("book control routes", () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  let repo: BookRepository;
  let queue: ChapterQueue;
  let events: AppEvent[];

  /** A converted book with `done` finished chapters (with audio files) and the rest queued. */
  const addBook = (chapters = 3, done = 0, convert = true) => {
    const id = randomUUID();
    repo.insert(
      {
        id,
        title: "Book",
        author: null,
        language: "en",
        coverMime: null,
        coverPath: null,
        sourcePath: `books/${id}/source.epub`,
      },
      Array.from({ length: chapters }, (_, i) => ({
        title: `C${i + 1}`,
        text: "Hello.",
        wordCount: 1,
      })),
    );
    ctx.storage.ensureBookDir(id);
    ctx.storage.ensureAudioDir(id);
    fs.writeFileSync(path.join(ctx.storage.bookDir(id), "source.epub"), "epub");
    if (convert) repo.queue(id);
    for (let i = 0; i < done; i++) {
      const task = queue.claimNext(LANGUAGES);
      if (!task) throw new Error("expected a chapter");
      const rel = ctx.storage.audioRelPath(id, task.position);
      fs.writeFileSync(ctx.storage.resolve(rel), "0123456789");
      queue.markDone(task, rel, 5);
    }
    return id;
  };
  const post = (target: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: target, headers });
  const bookStatus = (id: string) => repo.get(id)?.status;

  beforeEach(() => {
    ctx = createTestContext();
    repo = new BookRepository(ctx.db);
    queue = new ChapterQueue(ctx.db);
    events = [];
    ctx.bus.subscribe((event) => events.push(event));
    app = buildServer({
      db: ctx.db,
      storage: ctx.storage,
      catalog: ctx.catalog,
      maxUploadBytes: 1024 * 1024,
      bus: ctx.bus,
      pool: ctx.pool,
      outputs: ctx.outputs,
      settings: ctx.settings,
    });
  });

  afterEach(async () => {
    await app.close();
    ctx.cleanup();
  });

  describe("pause and resume", () => {
    it("pauses a converting book and answers with it", async () => {
      const id = addBook();

      const res = await post(url(id, "/pause"));

      expect(res.statusCode).toBe(200);
      expect(res.json<BookJson>()).toMatchObject({ id, status: "paused" });
      expect(bookStatus(id)).toBe("paused");
      expect(events).toContainEqual(expect.objectContaining({ type: "book", status: "paused" }));
    });

    it("resumes a paused book", async () => {
      const id = addBook();
      await post(url(id, "/pause"));

      const res = await post(url(id, "/resume"));

      expect(res.statusCode).toBe(200);
      expect(res.json<BookJson>().status).toBe("converting");
    });

    it("answers 409 when the book is in the wrong state", async () => {
      const ready = addBook(1, 0, false);
      const converting = addBook();

      expect((await post(url(ready, "/pause"))).statusCode).toBe(409);
      expect((await post(url(converting, "/resume"))).json()).toMatchObject({ error: "conflict" });
      await post(url(converting, "/pause"));
      expect((await post(url(converting, "/pause"))).statusCode).toBe(409);
    });
  });

  describe("regenerate", () => {
    it("queues a finished chapter again and keeps its audio playable", async () => {
      const id = addBook(2, 2);
      expect(bookStatus(id)).toBe("converting"); // the test never refreshes it

      const res = await post(url(id, "/chapters/1/regenerate"));

      expect(res.statusCode).toBe(200);
      expect(res.json<BookJson>().chapters[0]).toMatchObject({
        status: "queued",
        hasAudio: true,
        audioVersion: 1,
      });
      const audio = await app.inject({ url: url(id, "/chapters/1/audio") });
      expect(audio.statusCode).toBe(200);
      expect(audio.body).toBe("0123456789");
    });

    it("serves the version the player asks for and refuses an old one with 410", async () => {
      const id = addBook(1, 1);
      const audio = (query: string) => app.inject({ url: url(id, `/chapters/1/audio${query}`) });

      expect((await audio("?v=1")).statusCode).toBe(200);
      expect((await audio("")).statusCode).toBe(200);
      // The chapter's audio is replaced: version 2 is current, 1 is gone.
      ctx.db.prepare("UPDATE chapters SET audio_version = 2 WHERE book_id = ?").run(id);

      const old = await audio("?v=1");
      expect(old.statusCode).toBe(410);
      expect(old.json()).toEqual({
        error: "version_changed",
        message: "A new version of this chapter is ready.",
      });
      const oldRange = await app.inject({
        url: url(id, "/chapters/1/audio?v=1"),
        headers: { range: "bytes=2-3" },
      });
      expect(oldRange.statusCode).toBe(410);
      expect((await audio("?v=2")).statusCode).toBe(200);
      expect((await audio("?v=x")).statusCode).toBe(400);
      expect((await audio("?v=1&v=2")).statusCode).toBe(400);
      expect((await audio("?v=-1")).statusCode).toBe(400);
    });

    it("shows a failed regeneration as a note on a chapter that is still done", async () => {
      const id = addBook(1, 1);
      ctx.db.prepare("UPDATE chapters SET regen_error = 'Engine down.' WHERE book_id = ?").run(id);

      const res = await app.inject({ url: url(id) });

      expect(
        res.json<{ chapters: { status: string; regenError: string | null }[] }>().chapters[0],
      ).toMatchObject({
        status: "done",
        regenError: "Engine down.",
      });
    });

    it("sends the whole new file to a client that asks for a range of the old one", async () => {
      const id = addBook(1, 1);
      const first = await app.inject({ url: url(id, "/chapters/1/audio") });

      const same = await app.inject({
        url: url(id, "/chapters/1/audio"),
        headers: { range: "bytes=2-3", "if-range": String(first.headers.etag) },
      });
      const changed = await app.inject({
        url: url(id, "/chapters/1/audio"),
        headers: { range: "bytes=2-3", "if-range": '"old-version"' },
      });

      expect(same.statusCode).toBe(206);
      expect(changed.statusCode).toBe(200);
      expect(changed.body).toBe("0123456789");
    });

    it("answers 200 and changes nothing for a chapter that is already waiting", async () => {
      const id = addBook(2, 1);
      events.length = 0;

      const res = await post(url(id, "/chapters/2/regenerate"));

      expect(res.statusCode).toBe(200);
      expect(events).toEqual([]);
      expect(repo.chapter(id, 2)?.status).toBe("queued");
    });

    it("regenerates every chapter of the book", async () => {
      const id = addBook(3, 2);

      const res = await post(url(id, "/regenerate"));

      expect(res.statusCode).toBe(200);
      expect(res.json<BookJson>().chapters.map((c) => c.status)).toEqual([
        "queued",
        "queued",
        "queued",
      ]);
      expect(res.json<BookJson>().doneCount).toBe(0);
    });

    it("answers 409 for a book that has not been converted, 404 and 400 for bad targets", async () => {
      const ready = addBook(1, 0, false);
      const id = addBook(1, 1);

      expect((await post(url(ready, "/regenerate"))).statusCode).toBe(409);
      expect((await post(url(ready, "/chapters/1/regenerate"))).statusCode).toBe(409);
      expect((await post(url(id, "/chapters/9/regenerate"))).statusCode).toBe(404);
      expect((await post(url(randomUUID(), "/regenerate"))).statusCode).toBe(404);
      expect((await post(url(randomUUID(), "/chapters/1/regenerate"))).statusCode).toBe(404);
      expect((await post(url(id, "/chapters/0/regenerate"))).statusCode).toBe(400);
      expect((await post(url(id, "/chapters/x/regenerate"))).json()).toMatchObject({
        error: "invalid_position",
      });
      expect((await post("/api/books/not-an-id/regenerate")).statusCode).toBe(400);
    });
  });

  describe("DELETE /api/books/:id", () => {
    it("answers 204 and removes the rows, the files and then announces it", async () => {
      const id = addBook(2, 1);
      events.length = 0;

      const res = await app.inject({ method: "DELETE", url: url(id) });

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      expect(repo.get(id)).toBeUndefined();
      expect(fs.existsSync(ctx.storage.bookDir(id))).toBe(false);
      expect(fs.existsSync(ctx.storage.audioDir(id))).toBe(false);
      expect(events).toEqual([{ type: "book-deleted", bookId: id }]);
      expect((await app.inject({ url: url(id) })).statusCode).toBe(404);
    });

    it("deletes books in every status", async () => {
      const ready = addBook(1, 0, false);
      const paused = addBook(2);
      await post(url(paused, "/pause"));
      const done = addBook(1, 1);
      queue.refreshBookStatus(done);

      for (const id of [ready, paused, done]) {
        expect((await app.inject({ method: "DELETE", url: url(id) })).statusCode).toBe(204);
      }
      expect(repo.list()).toEqual([]);
    });

    it("answers 404 for a book that is gone and 400 for a bad id", async () => {
      const id = addBook();
      await app.inject({ method: "DELETE", url: url(id) });

      expect((await app.inject({ method: "DELETE", url: url(id) })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: "/api/books/nope" })).statusCode).toBe(400);
    });

    it("still answers 204 when some files could not be removed", async () => {
      const id = addBook();
      const real = ctx.storage.removeBookFiles.bind(ctx.storage);
      ctx.storage.removeBookFiles = () => {
        throw new Error("EBUSY");
      };

      const res = await app.inject({ method: "DELETE", url: url(id) });
      ctx.storage.removeBookFiles = real;

      expect(res.statusCode).toBe(204);
      expect(repo.get(id)).toBeUndefined();
    });
  });

  describe("cross-site requests and bad hosts", () => {
    it("refuses a cross-site request to every route and changes nothing", async () => {
      const id = addBook(2, 1);
      const cross = [
        { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        { origin: "https://evil.example" },
        { "sec-fetch-site": "same-site" },
      ];

      for (const headers of cross) {
        for (const call of calls(id)) {
          const res = await app.inject({ ...call, headers });
          expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
        }
      }
      expect(bookStatus(id)).toBe("converting");
      expect(repo.chapter(id, 1)?.status).toBe("done");
    });

    it("refuses another Host", async () => {
      const id = addBook();

      for (const call of calls(id)) {
        const res = await app.inject({ ...call, headers: { host: "evil.example" } });
        expect(res.statusCode).toBe(403);
      }
      expect(repo.get(id)).toBeDefined();
    });

    it("accepts the same origin", async () => {
      const id = addBook();

      const res = await app.inject({
        method: "POST",
        url: url(id, "/pause"),
        headers: {
          host: "localhost:3300",
          origin: "http://localhost:3300",
          "sec-fetch-site": "same-origin",
        },
      });

      expect(res.statusCode).toBe(200);
    });
  });
});
