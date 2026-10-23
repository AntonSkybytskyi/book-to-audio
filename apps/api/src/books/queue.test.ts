import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { ChapterQueue } from "./queue.js";
import { BookRepository, type NewChapter } from "./repository.js";

const chapters = (n: number): NewChapter[] =>
  Array.from({ length: n }, (_, i) => ({
    title: `Chapter ${i + 1}`,
    text: `Text ${i + 1}.`,
    wordCount: 2,
  }));

/** Queues a book and ends its chapters one by one with the given outcomes. */
function finishChapters(
  repo: BookRepository,
  queue: ChapterQueue,
  id: string,
  outcomes: ("done" | "failed")[],
) {
  repo.queue(id);
  for (const outcome of outcomes) {
    const task = queue.claimNext();
    if (!task) throw new Error("expected a chapter");
    if (outcome === "done") queue.markDone(task, "a.webm", 1);
    else queue.markFailed(task, "x");
  }
}

describe("BookRepository and ChapterQueue", () => {
  let ctx: TestContext;
  let repo: BookRepository;
  let queue: ChapterQueue;

  const addBook = (title: string, count = 2, language = "en") => {
    const id = randomUUID();
    repo.insert(
      {
        id,
        title,
        author: null,
        language,
        coverMime: null,
        coverPath: null,
        sourcePath: `books/${id}/source.epub`,
      },
      chapters(count),
    );
    return id;
  };

  const claim = (id: string) => {
    repo.queue(id);
    const task = queue.claimNext();
    if (!task) throw new Error("expected a chapter");
    return task;
  };

  // The chapter was taken back and claimed again while the first worker was still busy.
  const reclaimed = () => {
    const id = addBook("A", 1);
    const stale = claim(id);
    expect(queue.resetInterrupted()).toBe(1);
    const current = queue.claimNext();
    if (!current) throw new Error("expected the chapter again");
    return { id, stale, current };
  };

  beforeEach(() => {
    ctx = createTestContext();
    repo = new BookRepository(ctx.db);
    queue = new ChapterQueue(ctx.db);
  });

  afterEach(() => ctx.cleanup());

  describe("repository", () => {
    it("stores a book with numbered chapters and char counts", () => {
      const id = addBook("A", 3);

      expect(repo.get(id)).toMatchObject({
        title: "A",
        status: "ready",
        chapterCount: 3,
        wordCount: 6,
      });
      expect(repo.chapters(id).map((c) => [c.position, c.charCount, c.status])).toEqual([
        [1, 7, "pending"],
        [2, 7, "pending"],
        [3, 7, "pending"],
      ]);
    });

    it("rolls back the whole book when a chapter cannot be stored", () => {
      const id = randomUUID();
      const bad = [
        { title: "x", text: "y", wordCount: 1 },
        { title: null as unknown as string, text: "z", wordCount: 1 },
      ];

      expect(() =>
        repo.insert(
          {
            id,
            title: "A",
            author: null,
            language: "en",
            coverMime: null,
            coverPath: null,
            sourcePath: "s",
          },
          bad,
        ),
      ).toThrow(/NOT NULL/);
      expect(repo.get(id)).toBeUndefined();
    });

    it("only changes the language of a ready book", () => {
      const id = addBook("A");

      expect(repo.setLanguage(id, "uk")).toBe(true);
      repo.queue(id);
      expect(repo.setLanguage(id, "ru")).toBe(false);
      expect(repo.get(id)?.language).toBe("uk");
    });

    it("queues a ready book once and moves its chapters from pending to queued", () => {
      const id = addBook("A");
      expect(repo.chapters(id).map((c) => c.status)).toEqual(["pending", "pending"]);

      expect(repo.queue(id)).toBe(true);
      expect(repo.queue(id)).toBe(false);
      expect(repo.get(id)?.status).toBe("converting");
      expect(repo.chapters(id).map((c) => c.status)).toEqual(["queued", "queued"]);
    });

    it("cascades chapter deletion with the book", () => {
      const id = addBook("A");

      ctx.db.prepare("DELETE FROM books WHERE id = ?").run(id);

      expect(ctx.db.prepare("SELECT count(*) FROM chapters").pluck().get()).toBe(0);
    });
  });

  describe("claimNext", () => {
    it("returns nothing for books that are not converting", () => {
      addBook("A");

      expect(queue.claimNext()).toBeNull();
    });

    it("takes chapters in order and marks them generating", () => {
      const id = addBook("A", 2, "uk");
      repo.queue(id);

      const first = queue.claimNext();
      const second = queue.claimNext();

      expect(first).toMatchObject({ bookId: id, position: 1, text: "Text 1.", language: "uk" });
      expect(second).toMatchObject({ position: 2 });
      expect(queue.claimNext()).toBeNull();
      expect(repo.chapters(id).map((c) => c.status)).toEqual(["generating", "generating"]);
    });

    it("serves the earliest queued book first, not the earliest uploaded", () => {
      const first = addBook("uploaded first", 1);
      const second = addBook("uploaded second", 1);
      repo.queue(second);
      ctx.db
        .prepare("UPDATE books SET queued_at = '2030-01-01T00:00:00.000Z' WHERE id = ?")
        .run(second);
      repo.queue(first);

      expect(queue.claimNext()?.bookId).toBe(first);
      expect(queue.claimNext()?.bookId).toBe(second);
    });
  });

  describe("claiming with several workers", () => {
    it("hands every chapter to exactly one of two connections to the same database", () => {
      for (let i = 0; i < 6; i++) repo.queue(addBook(`Book ${i}`, 5));
      const other = openDatabase(ctx.dataDir);
      try {
        const queues = [queue, new ChapterQueue(other)];
        const seen: number[] = [];
        for (let turn = 0; ; turn++) {
          const task = queues[turn % 2]?.claimNext();
          if (!task) break;
          seen.push(task.id);
        }

        expect(seen).toHaveLength(30);
        expect(new Set(seen).size).toBe(30);
      } finally {
        other.close();
      }
    });

    it("lists the books that are being converted", () => {
      const converting = addBook("A");
      addBook("B"); // ready, not queued
      repo.queue(converting);

      expect(queue.activeBookIds()).toEqual([converting]);
    });

    it("does not take chapters of a paused book", () => {
      const id = addBook("A", 2);
      repo.queue(id);
      ctx.db.prepare("UPDATE books SET status = 'paused' WHERE id = ?").run(id);

      expect(queue.claimNext()).toBeNull();
    });
  });

  describe("results", () => {
    it("records chunks, completion and failure", () => {
      const id = addBook("A", 2);
      repo.queue(id);
      const one = queue.claimNext();
      const two = queue.claimNext();
      if (!one || !two) throw new Error("expected two chapters");

      expect(queue.recordChunks(one, 2, 5)).toBe(true);
      expect(repo.chapter(id, 1)).toMatchObject({
        status: "generating",
        progress: 0.4,
        chunkCount: 5,
        chunksDone: 2,
      });
      expect(queue.markDone(one, "audio/x/01.webm", 61.5)).toBe(true);
      expect(queue.recordChunks(two, 1, 3)).toBe(true);
      expect(queue.markFailed(two, "boom")).toBe(true);

      expect(repo.chapter(id, 1)).toMatchObject({
        status: "done",
        progress: 1,
        chunksDone: 5,
        audioPath: "audio/x/01.webm",
        durationSeconds: 61.5,
      });
      // The finished chunks stay, so running the chapter again can continue from them.
      expect(repo.chapter(id, 2)).toMatchObject({
        status: "failed",
        error: "boom",
        chunkCount: 3,
        chunksDone: 1,
      });
    });

    it("keeps the finished chunks when a chapter is put back in the queue", () => {
      const id = addBook("A", 1);
      const task = claim(id);
      queue.recordChunks(task, 3, 8);

      expect(queue.requeue(task)).toBe(true);

      expect(repo.chapter(id, 1)).toMatchObject({ status: "queued", chunksDone: 3, chunkCount: 8 });
      expect(queue.claimNext()).toMatchObject({ claim: 2, chunksDone: 3, chunkCount: 8 });
    });

    it("counts each claim of a chapter", () => {
      const id = addBook("A", 1);
      const first = claim(id);
      queue.requeue(first);

      expect(first.claim).toBe(1);
      expect(queue.claimNext()?.claim).toBe(2);
    });

    describe("a stale claim", () => {
      it("cannot record chunks, finish or fail the chapter", () => {
        const { id, stale, current } = reclaimed();
        queue.recordChunks(current, 1, 4);

        expect(queue.recordChunks(stale, 4, 4)).toBe(false);
        expect(queue.markDone(stale, "late.webm", 9)).toBe(false);
        expect(queue.markFailed(stale, "late")).toBe(false);
        expect(queue.requeue(stale)).toBe(false);

        expect(repo.chapter(id, 1)).toMatchObject({
          status: "generating",
          chunksDone: 1,
          audioPath: null,
          error: null,
        });
      });

      it("cannot overwrite a chapter that is back in the queue", () => {
        const id = addBook("A", 1);
        const task = claim(id);
        queue.requeue(task);

        expect(queue.markDone(task, "late.webm", 9)).toBe(false);
        expect(queue.recordChunks(task, 1, 2)).toBe(false);

        expect(repo.chapter(id, 1)).toMatchObject({ status: "queued", audioPath: null });
      });

      it("cannot reopen a chapter that finished", () => {
        const { id, stale, current } = reclaimed();
        queue.markDone(current, "a.webm", 1);

        expect(queue.markFailed(stale, "late")).toBe(false);
        expect(queue.requeue(stale)).toBe(false);

        expect(repo.chapter(id, 1)).toMatchObject({ status: "done", error: null });
      });
    });

    it("tells whether a file belongs to a chapter", () => {
      const id = addBook("A", 1);
      queue.markDone(claim(id), "audio/x/01.webm", 1);

      expect(queue.audioInUse("audio/x/01.webm")).toBe(true);
      expect(queue.audioInUse("audio/x/02.webm")).toBe(false);
    });

    it("reports the counts of a book", () => {
      const id = addBook("A", 3);
      finishChapters(repo, queue, id, ["done", "failed"]);

      expect(queue.bookCounts(id)).toEqual({
        status: "converting",
        doneCount: 1,
        failedCount: 1,
        durationSeconds: 1,
      });
      expect(queue.bookCounts(randomUUID())).toBeNull();
    });
  });

  describe("book status", () => {
    it("stays converting while chapters are open", () => {
      const id = addBook("A", 2);
      finishChapters(repo, queue, id, ["done"]);

      expect(queue.refreshBookStatus(id)).toBe("converting");
    });

    it("becomes done when every chapter is done", () => {
      const id = addBook("A", 2);
      finishChapters(repo, queue, id, ["done", "done"]);

      expect(queue.refreshBookStatus(id)).toBe("done");
      expect(repo.get(id)?.status).toBe("done");
    });

    it("becomes done_with_errors when a chapter failed", () => {
      const id = addBook("A", 2);
      finishChapters(repo, queue, id, ["done", "failed"]);

      expect(queue.refreshBookStatus(id)).toBe("done_with_errors");
    });

    it("leaves ready books alone and ignores unknown ids", () => {
      const id = addBook("A");

      expect(queue.refreshBookStatus(id)).toBe("ready");
      expect(queue.refreshBookStatus(randomUUID())).toBeNull();
    });

    it("settles books whose last chapter finished before a restart", () => {
      const id = addBook("A", 1);
      finishChapters(repo, queue, id, ["done"]);

      queue.refreshAllActive();

      expect(repo.get(id)?.status).toBe("done");
    });
  });

  describe("resetInterrupted", () => {
    it("puts generating chapters back in the queue with their chunks", () => {
      const id = addBook("A", 2);
      repo.queue(id);
      const task = queue.claimNext();
      if (!task) throw new Error("expected a chapter");
      queue.recordChunks(task, 2, 4);

      expect(queue.resetInterrupted()).toBe(1);

      expect(repo.chapters(id).map((c) => [c.status, c.progress, c.chunksDone])).toEqual([
        ["queued", 0.5, 2],
        ["queued", 0, 0],
      ]);
      expect(queue.claimNext()).toMatchObject({ position: 1, chunksDone: 2, chunkCount: 4 });
    });
  });
});
