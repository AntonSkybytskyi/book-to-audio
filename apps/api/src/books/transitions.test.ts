import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../testing/context.js";
import { ChapterQueue } from "./queue.js";
import { BookRepository } from "./repository.js";
import { BookTransitions } from "./transitions.js";
import { LANGUAGES } from "./languages.js";

describe("BookTransitions", () => {
  let ctx: TestContext;
  let repo: BookRepository;
  let queue: ChapterQueue;
  let transitions: BookTransitions;

  const addBook = (count = 3, queued = true) => {
    const id = randomUUID();
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
      Array.from({ length: count }, (_, i) => ({ title: `C${i + 1}`, text: "x.", wordCount: 1 })),
    );
    if (queued) repo.queue(id);
    return id;
  };

  const claim = () => {
    const task = queue.claimNext(LANGUAGES);
    if (!task) throw new Error("expected a chapter");
    return task;
  };
  const finish = (id: string, outcomes: ("done" | "failed")[]) => {
    for (const outcome of outcomes) {
      const task = claim();
      if (outcome === "done") queue.markDone(task, `audio/${id}/${task.position}.webm`, 4);
      else {
        queue.recordChunks(task, 2, 5);
        queue.markFailed(task, "boom");
      }
    }
    queue.refreshBookStatus(id);
  };
  const regenerateAndFail = (id: string) => {
    transitions.restart(id, { position: 1, fresh: true });
    const task = claim();
    queue.recordChunks(task, 2, 5);
    expect(queue.markFailed(task, "The engine failed.")).toBe(true);
    expect(queue.hasAudio(task.id)).toBe(true);
    return task;
  };
  const statuses = (id: string) => repo.chapters(id).map((c) => c.status);
  const queuedAt = (id: string) =>
    ctx.db.prepare("SELECT queued_at FROM books WHERE id = ?").pluck().get(id) as string;

  beforeEach(() => {
    ctx = createTestContext();
    repo = new BookRepository(ctx.db);
    queue = new ChapterQueue(ctx.db);
    transitions = new BookTransitions(ctx.db, queue);
  });

  afterEach(() => ctx.cleanup());

  describe("pause and resume", () => {
    it("pauses only a converting book", () => {
      const converting = addBook();
      const ready = addBook(1, false);

      expect(transitions.pause(converting)).toBe(true);
      expect(transitions.pause(converting)).toBe(false);
      expect(transitions.pause(ready)).toBe(false);
      expect(transitions.pause(randomUUID())).toBe(false);
      expect(repo.get(converting)?.status).toBe("paused");
      expect(repo.get(ready)?.status).toBe("ready");
    });

    it("stops new chapters from being claimed but does not touch the running one", () => {
      const id = addBook();
      const running = claim();

      transitions.pause(id);

      expect(queue.claimNext(LANGUAGES)).toBeNull();
      expect(statuses(id)).toEqual(["generating", "queued", "queued"]);
      expect(queue.markDone(running, "a.webm", 1)).toBe(true);
    });

    it("stays paused while chapters are waiting, and settles once none is left", () => {
      const id = addBook(2);
      const first = claim();
      transitions.pause(id);

      queue.markDone(first, "a.webm", 1);
      expect(queue.refreshBookStatus(id)).toBe("paused");

      // The second chapter is taken off the queue by hand: nothing is left to wait for.
      ctx.db.prepare("UPDATE chapters SET status = 'failed' WHERE position = 2").run();
      expect(queue.refreshBookStatus(id)).toBe("done_with_errors");
    });

    it("settles a paused book that finished before a restart", () => {
      const id = addBook(1);
      queue.markDone(claim(), "a.webm", 1);
      transitions.pause(id);
      ctx.db.prepare("UPDATE books SET status = 'paused' WHERE id = ?").run(id);

      queue.refreshAllActive();

      expect(repo.get(id)?.status).toBe("done");
    });

    it("resumes a paused book and keeps its place in the queue", () => {
      const first = addBook(2);
      const second = addBook(2);
      const firstQueuedAt = queuedAt(first);
      transitions.pause(first);
      expect(claim()).toMatchObject({ bookId: second });

      expect(transitions.resume(first)).toBe("converting");

      expect(queuedAt(first)).toBe(firstQueuedAt);
      expect(claim()).toMatchObject({ bookId: first, position: 1 });
    });

    it("resumes straight to the final status when nothing is left", () => {
      const id = addBook(1);
      queue.markDone(claim(), "a.webm", 1);
      ctx.db.prepare("UPDATE books SET status = 'paused' WHERE id = ?").run(id);

      expect(transitions.resume(id)).toBe("done");
      expect(repo.get(id)?.status).toBe("done");
    });

    it("refuses to resume a book that is not paused", () => {
      const id = addBook();

      expect(transitions.resume(id)).toBeNull();
      expect(transitions.resume(randomUUID())).toBeNull();
      expect(repo.get(id)?.status).toBe("converting");
    });
  });

  describe("suspend", () => {
    it("holds running and waiting chapters of a book, and makes the running attempt stale", () => {
      const id = addBook(3);
      const running = claim();

      const ids = transitions.suspend(id);

      expect(ids).toHaveLength(3);
      expect(statuses(id)).toEqual(["generating", "generating", "generating"]);
      expect(queue.claimNext(LANGUAGES)).toBeNull();
      expect(queue.recordChunks(running, 1, 2)).toBe(false);
      expect(queue.markDone(running, "a.webm", 1)).toBe(false);
      expect(queue.requeue(running)).toBe(false);
    });

    it("holds only the one running chapter when given a position", () => {
      const id = addBook(3);
      claim();

      expect(transitions.suspend(id, 2)).toEqual([]); // waiting, not running
      expect(transitions.suspend(id, 1)).toHaveLength(1);

      expect(statuses(id)).toEqual(["generating", "queued", "queued"]);
    });
  });

  describe("restart", () => {
    it("queues a finished chapter again with its old audio, and the book at the back of the queue", () => {
      const id = addBook(1);
      finish(id, ["done"]);
      const other = addBook(1);
      expect(repo.get(id)?.status).toBe("done");
      // Fixed times, so that the order does not depend on the clock's resolution.
      const setQueuedAt = ctx.db.prepare("UPDATE books SET queued_at = ? WHERE id = ?");
      setQueuedAt.run("2000-01-01T00:00:00.000Z", id);
      setQueuedAt.run("2000-01-02T00:00:00.000Z", other);

      const result = transitions.restart(id, { position: 1, fresh: true });

      expect(result).toEqual({ positions: [1], status: "converting" });
      expect(repo.chapter(id, 1)).toMatchObject({
        status: "queued",
        progress: 0,
        chunkCount: 0,
        chunksDone: 0,
        error: null,
        audioPath: `audio/${id}/1.webm`,
        durationSeconds: 4,
      });
      expect(repo.get(id)?.status).toBe("converting");
      // The other book was queued later than the first, but this one re-entered the queue after it.
      expect(claim()).toMatchObject({ bookId: other });
    });

    it("keeps the saved chunk count of a failed chapter unless the restart is fresh", () => {
      const id = addBook(2);
      finish(id, ["failed", "done"]);
      expect(repo.get(id)?.status).toBe("done_with_errors");

      transitions.restart(id, { position: 1, fresh: false });

      expect(repo.chapter(id, 1)).toMatchObject({
        status: "queued",
        error: null,
        chunkCount: 5,
        chunksDone: 2,
        progress: 0.4,
      });
      expect(repo.get(id)?.status).toBe("converting");
      expect(claim()).toMatchObject({ position: 1, chunksDone: 2, chunkCount: 5 });
    });

    it("leaves a waiting chapter alone when asked for that one chapter", () => {
      const id = addBook(2);

      expect(transitions.restart(id, { position: 1, fresh: true })).toEqual({
        positions: [],
        status: "converting",
      });
      expect(statuses(id)).toEqual(["queued", "queued"]);
    });

    it("restarts every chapter of a book, keeping a converting book's place", () => {
      const id = addBook(3);
      const before = queuedAt(id);
      finish(id, ["done", "failed"]);
      const running = claim();

      const result = transitions.restart(id, { fresh: true });

      expect(result).toEqual({ positions: [1, 2, 3], status: "converting" });
      expect(statuses(id)).toEqual(["queued", "queued", "queued"]);
      expect(repo.chapter(id, 2)).toMatchObject({ chunkCount: 0, chunksDone: 0 });
      expect(queuedAt(id)).toBe(before);
      expect(queue.markDone(running, "x.webm", 1)).toBe(false); // the old attempt is stale
    });

    it("restarts only the given chapters when asked to", () => {
      const id = addBook(3);
      finish(id, ["done", "failed", "done"]);
      const ids = ctx.db
        .prepare("SELECT id FROM chapters WHERE position IN (1, 3) ORDER BY position")
        .pluck()
        .all() as number[];

      const result = transitions.restart(id, { fresh: false, ids });

      expect(result?.positions).toEqual([1, 3]);
      expect(statuses(id)).toEqual(["queued", "failed", "queued"]);
    });

    it("keeps a paused book paused", () => {
      const id = addBook(1);
      finish(id, ["done"]);
      ctx.db.prepare("UPDATE books SET status = 'paused' WHERE id = ?").run(id);

      expect(transitions.restart(id, { position: 1, fresh: true })?.status).toBe("paused");
      expect(queue.claimNext(LANGUAGES)).toBeNull();
    });

    it("does nothing for a book that has not been queued or does not exist", () => {
      const ready = addBook(2, false);

      expect(transitions.restart(ready, { fresh: true })).toBeNull();
      expect(transitions.restart(randomUUID(), { fresh: true })).toBeNull();
      expect(statuses(ready)).toEqual(["pending", "pending"]);
    });
  });

  describe("remove", () => {
    it("deletes the book and its chapters", () => {
      const id = addBook(2);
      const other = addBook(1);

      expect(transitions.remove(id)).toBe(true);
      expect(transitions.remove(id)).toBe(false);

      expect(repo.get(id)).toBeUndefined();
      expect(repo.chapters(id)).toEqual([]);
      expect(repo.chapters(other)).toHaveLength(1);
    });

    it("makes updates from a worker that was running a chapter of it do nothing", () => {
      const id = addBook(1);
      const running = claim();

      transitions.remove(id);

      expect(queue.recordChunks(running, 1, 2)).toBe(false);
      expect(queue.markDone(running, "a.webm", 1)).toBe(false);
      expect(queue.markFailed(running, "x")).toBe(false);
      expect(queue.requeue(running)).toBe(false);
    });
  });

  describe("audio version and generation", () => {
    it("bumps the chapter's version and the book's generation each time audio is written", () => {
      const id = addBook(2);
      expect(repo.audioGeneration(id)).toBe(0);

      queue.markDone(claim(), "a.webm", 1);
      expect(repo.chapter(id, 1)?.audioVersion).toBe(1);
      expect(repo.audioGeneration(id)).toBe(1);

      queue.markDone(claim(), "b.webm", 1);
      expect(repo.audioGeneration(id)).toBe(2);

      transitions.restart(id, { position: 1, fresh: true });
      expect(repo.audioGeneration(id)).toBe(2); // nothing was replaced yet
      queue.markDone(claim(), "a.webm", 2);

      expect(repo.chapter(id, 1)?.audioVersion).toBe(2);
      expect(repo.chapter(id, 2)?.audioVersion).toBe(1);
      expect(repo.audioGeneration(id)).toBe(3);
    });

    it("does not touch them for a result that is dropped", () => {
      const id = addBook(1);
      const stale = claim();
      queue.resetInterrupted();
      claim();

      expect(queue.markDone(stale, "a.webm", 1)).toBe(false);

      expect(repo.chapter(id, 1)?.audioVersion).toBe(0);
      expect(repo.audioGeneration(id)).toBe(0);
    });
  });

  describe("a failed regeneration", () => {
    it("puts a chapter that has audio back to done with its audio, and keeps the message", () => {
      const id = addBook(1);
      queue.markDone(claim(), "audio/a.webm", 7);

      regenerateAndFail(id);

      expect(repo.chapter(id, 1)).toMatchObject({
        status: "done",
        error: null,
        regenError: "The engine failed.",
        audioPath: "audio/a.webm",
        durationSeconds: 7,
        audioVersion: 1,
        progress: 1,
        chunkCount: 0,
        chunksDone: 0,
      });
      expect(queue.refreshBookStatus(id)).toBe("done");
      expect(repo.audioGeneration(id)).toBe(1);
    });

    it("clears the message when the chapter is regenerated again, and when it succeeds", () => {
      const id = addBook(1);
      queue.markDone(claim(), "audio/a.webm", 7);
      regenerateAndFail(id);

      transitions.restart(id, { position: 1, fresh: true });
      expect(repo.chapter(id, 1)?.regenError).toBeNull();

      regenerateAndFail(id);
      // Queued by hand with the message still there: finishing is what clears it.
      ctx.db.prepare("UPDATE chapters SET status = 'queued' WHERE book_id = ?").run(id);
      expect(repo.chapter(id, 1)?.regenError).not.toBeNull();
      queue.markDone(claim(), "audio/a.webm", 8);

      expect(repo.chapter(id, 1)).toMatchObject({ status: "done", regenError: null });
    });

    it("fails a chapter that has no audio, as before, and keeps its chunks", () => {
      const id = addBook(1);
      const task = claim();
      queue.recordChunks(task, 2, 5);

      queue.markFailed(task, "boom");

      expect(queue.hasAudio(task.id)).toBe(false);
      expect(repo.chapter(id, 1)).toMatchObject({
        status: "failed",
        error: "boom",
        regenError: null,
        chunkCount: 5,
        chunksDone: 2,
      });
      expect(queue.refreshBookStatus(id)).toBe("done_with_errors");
    });
  });
});
