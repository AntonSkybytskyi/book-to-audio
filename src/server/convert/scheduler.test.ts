import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChapterQueue } from "../books/queue.js";
import { BookRepository } from "../books/repository.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import type { ChapterConverter } from "./convert-chapter.js";
import { GENERIC_CHAPTER_ERROR } from "../errors.js";
import { TtsError } from "../tts/engine.js";
import { Scheduler, type SchedulerLogger } from "./scheduler.js";

const until = async (condition: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok: ChapterConverter = async (task, onProgress) => {
  onProgress(0.5);
  return { audioPath: `audio/${task.bookId}/${task.position}.webm`, durationSeconds: 3 };
};

describe("Scheduler", () => {
  let ctx: TestContext;
  let repo: BookRepository;
  let queue: ChapterQueue;
  let scheduler: Scheduler | undefined;

  const addBook = (chapterCount: number, queued = true) => {
    const id = randomUUID();
    repo.insert(
      {
        id,
        title: "Book",
        author: null,
        language: "en",
        coverMime: null,
        coverPath: null,
        sourcePath: "s",
      },
      Array.from({ length: chapterCount }, (_, i) => ({
        title: `C${i + 1}`,
        text: "Hello.",
        wordCount: 1,
      })),
    );
    if (queued) repo.queue(id);
    return id;
  };

  const start = (convert: ChapterConverter, logger?: SchedulerLogger) => {
    scheduler = new Scheduler({ queue, convert, logger, backoffMs: 5 });
    scheduler.start();
    return scheduler;
  };

  beforeEach(() => {
    ctx = createTestContext();
    repo = new BookRepository(ctx.db);
    queue = new ChapterQueue(ctx.db);
  });

  afterEach(async () => {
    await scheduler?.stop();
    scheduler = undefined;
    ctx.cleanup();
  });

  it("converts every chapter in order and finishes the book", async () => {
    const order: number[] = [];
    const id = addBook(3);

    start(async (task, onProgress, signal) => {
      order.push(task.position);
      return ok(task, onProgress, signal);
    });

    await until(() => repo.get(id)?.status === "done");
    expect(order).toEqual([1, 2, 3]);
    expect(repo.chapters(id).map((c) => [c.status, c.progress, c.durationSeconds])).toEqual([
      ["done", 1, 3],
      ["done", 1, 3],
      ["done", 1, 3],
    ]);
  });

  it("marks a failing chapter failed and carries on", async () => {
    const id = addBook(3);

    start(async (task, onProgress, signal) => {
      if (task.position === 2) throw new TtsError("synthesis_failed", "The speech engine failed.");
      return ok(task, onProgress, signal);
    });

    await until(() => repo.get(id)?.status === "done_with_errors");
    expect(repo.chapters(id).map((c) => c.status)).toEqual(["done", "failed", "done"]);
    expect(repo.chapter(id, 2)?.error).toBe("The speech engine failed.");
  });

  it("stores a generic message, not the raw text, for unexpected errors", async () => {
    const id = addBook(1);
    const errors: object[] = [];

    start(
      async () => {
        throw new Error("ENOENT /private/path/secret.onnx");
      },
      { info: () => {}, error: (context) => errors.push(context) },
    );

    await until(() => repo.get(id)?.status === "done_with_errors");
    expect(repo.chapter(id, 1)?.error).toBe(GENERIC_CHAPTER_ERROR);
    expect(errors[0]).toMatchObject({
      err: expect.objectContaining({ message: expect.stringContaining("secret") }),
    });
  });

  it("logs the technical detail of a failure but stores only the message", async () => {
    const id = addBook(1);
    const errors: object[] = [];

    start(
      async () => {
        throw new TtsError("synthesis_failed", "The speech engine failed.", {
          detail: "exit 1: stack trace",
        });
      },
      { info: () => {}, error: (context) => errors.push(context) },
    );

    await until(() => repo.get(id)?.status === "done_with_errors");
    expect(repo.chapter(id, 1)?.error).toBe("The speech engine failed.");
    expect(errors[0]).toMatchObject({ detail: "exit 1: stack trace" });
  });

  it("keeps running when claiming a chapter throws", async () => {
    const id = addBook(1);
    vi.spyOn(queue, "claimNext").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    start(ok);

    await until(() => repo.get(id)?.status === "done");
    expect(repo.chapter(id, 1)?.status).toBe("done");
  });

  it("marks the chapter failed when saving its result throws", async () => {
    const id = addBook(2);
    vi.spyOn(queue, "markDone").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });

    start(ok);

    await until(() => repo.get(id)?.status === "done_with_errors");
    expect(repo.chapters(id).map((c) => [c.status, c.error])).toEqual([
      ["failed", "The result of this chapter could not be saved."],
      ["done", null],
    ]);
  });

  it("carries on with the next chapter even when recording a failure also throws", async () => {
    const id = addBook(2);
    vi.spyOn(queue, "markDone").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });
    vi.spyOn(queue, "markFailed").mockImplementationOnce(() => {
      throw new Error("disk I/O error again");
    });

    start(ok);

    await until(() => repo.chapter(id, 2)?.status === "done");
    // Left generating; the next start puts it back in the queue.
    expect(repo.chapter(id, 1)?.status).toBe("generating");
    expect(repo.get(id)?.status).toBe("converting");
  });

  it("does not let a failing status refresh stop the loop", async () => {
    const first = addBook(1);
    const second = addBook(1);
    start(ok);
    // After start, which settles books itself; the first chapter finishes asynchronously.
    vi.spyOn(queue, "refreshBookStatus").mockImplementationOnce(() => {
      throw new Error("busy");
    });

    await until(() => repo.chapter(second, 1)?.status === "done");
    expect(repo.chapter(first, 1)?.status).toBe("done");
  });

  it("records progress while a chapter runs", async () => {
    const id = addBook(1);
    const gate = deferred();

    start(async (task, onProgress, signal) => {
      onProgress(0.4);
      await gate.promise;
      return ok(task, onProgress, signal);
    });

    await until(() => repo.chapter(id, 1)?.progress === 0.4);
    expect(repo.chapter(id, 1)?.status).toBe("generating");
    gate.resolve();
    await until(() => repo.get(id)?.status === "done");
  });

  it("works through books earliest queued first", async () => {
    const order: string[] = [];
    const first = addBook(2, false);
    const second = addBook(1, false);
    repo.queue(first);
    ctx.db
      .prepare("UPDATE books SET queued_at = '2031-01-01T00:00:00.000Z' WHERE id = ?")
      .run(first);
    repo.queue(second);

    start(async (task, onProgress, signal) => {
      order.push(`${task.bookId === first ? "first" : "second"}:${task.position}`);
      return ok(task, onProgress, signal);
    });

    await until(() => repo.get(first)?.status === "done" && repo.get(second)?.status === "done");
    expect(order).toEqual(["second:1", "first:1", "first:2"]);
  });

  it("sleeps when idle and wakes on notify", async () => {
    const convert = vi.fn<ChapterConverter>(ok);
    start(convert);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(convert).not.toHaveBeenCalled();

    const id = addBook(1);
    scheduler?.notify();

    await until(() => repo.get(id)?.status === "done");
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("re-queues chapters left generating by a restart", async () => {
    const id = addBook(2);
    queue.claimNext(); // as if the previous process died mid-chapter
    expect(repo.chapter(id, 1)?.status).toBe("generating");

    start(ok);

    await until(() => repo.get(id)?.status === "done");
    expect(repo.chapters(id).map((c) => c.status)).toEqual(["done", "done"]);
  });

  it("settles a book that finished right before the restart", async () => {
    const id = addBook(1);
    const task = queue.claimNext();
    if (!task) throw new Error("expected a chapter");
    queue.markDone(task.id, "a.webm", 1);

    start(ok);

    await until(() => repo.get(id)?.status === "done");
    expect(repo.chapter(id, 1)?.status).toBe("done");
  });

  it("puts the running chapter back in the queue on stop", async () => {
    const id = addBook(1);
    let seenSignal: AbortSignal | undefined;
    const running = new Promise<void>((resolve) => {
      start((_task, _onProgress, signal) => {
        seenSignal = signal;
        resolve();
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      });
    });
    await running;

    await scheduler?.stop();

    expect(seenSignal?.aborted).toBe(true);
    expect(repo.chapter(id, 1)).toMatchObject({ status: "queued", progress: 0, error: null });
    expect(repo.get(id)?.status).toBe("converting");
  });

  it("can be started again after stop", async () => {
    const s = start(ok);
    await s.stop();
    const id = addBook(1);

    s.start();

    await until(() => repo.get(id)?.status === "done");
    expect(repo.chapter(id, 1)?.status).toBe("done");
  });
});
