import { describe, expect, it, vi } from "vitest";
import { GENERIC_CHAPTER_ERROR } from "../errors.js";
import { ok, stubConverter, tick, until, usePoolHarness } from "../testing/pool-harness.js";
import { TtsError } from "../tts/engine.js";

describe("WorkerPool: one worker", () => {
  const h = usePoolHarness();

  describe("one worker", () => {
    it("converts every chapter in order and finishes the book", async () => {
      const order: number[] = [];
      const id = h.addBook(3);

      h.start(
        stubConverter(async (run) => {
          order.push(run.task.position);
          return ok(run);
        }),
      );

      await until(() => h.bookStatus(id) === "done");
      expect(order).toEqual([1, 2, 3]);
      expect(h.repo.chapters(id).map((c) => [c.status, c.progress, c.durationSeconds])).toEqual([
        ["done", 1, 3],
        ["done", 1, 3],
        ["done", 1, 3],
      ]);
    });

    it("marks a failing chapter failed and carries on; the book ends done with errors", async () => {
      const id = h.addBook(3);

      h.start(
        stubConverter(async (run) => {
          if (run.task.position === 2) throw new TtsError("synthesis_failed", "The engine failed.");
          return ok(run);
        }),
      );

      await until(() => h.bookStatus(id) === "done_with_errors");
      expect(h.repo.chapters(id).map((c) => c.status)).toEqual(["done", "failed", "done"]);
      expect(h.repo.chapter(id, 2)?.error).toBe("The engine failed.");
    });

    it("stores a generic message, not the raw text, for unexpected errors", async () => {
      const id = h.addBook(1);

      h.start(
        stubConverter(async () => {
          throw new Error("ENOENT /private/path/secret.onnx");
        }),
      );

      await until(() => h.bookStatus(id) === "done_with_errors");
      expect(h.repo.chapter(id, 1)?.error).toBe(GENERIC_CHAPTER_ERROR);
      expect(h.logged.find((l) => l.message === "chapter failed")?.context).toMatchObject({
        err: expect.objectContaining({ message: expect.stringContaining("secret") }),
      });
    });

    it("logs the technical detail of a failure but stores only the message", async () => {
      const id = h.addBook(1);

      h.start(
        stubConverter(async () => {
          throw new TtsError("synthesis_failed", "The engine failed.", { detail: "exit 1: trace" });
        }),
      );

      await until(() => h.bookStatus(id) === "done_with_errors");
      expect(h.repo.chapter(id, 1)?.error).toBe("The engine failed.");
      expect(h.logged.find((l) => l.message === "chapter failed")?.context).toMatchObject({
        detail: "exit 1: trace",
      });
    });

    it("keeps running when claiming a chapter throws", async () => {
      const id = h.addBook(1);
      vi.spyOn(h.queue, "claimNext").mockImplementationOnce(() => {
        throw new Error("database is locked");
      });

      h.start(stubConverter(ok));

      await until(() => h.bookStatus(id) === "done");
      expect(h.repo.chapter(id, 1)?.status).toBe("done");
    });

    it("marks the chapter failed when saving its result throws", async () => {
      const id = h.addBook(2);
      vi.spyOn(h.queue, "markDone").mockImplementationOnce(() => {
        throw new Error("disk I/O error");
      });

      h.start(stubConverter(ok));

      await until(() => h.bookStatus(id) === "done_with_errors");
      expect(h.repo.chapters(id).map((c) => [c.status, c.error])).toEqual([
        ["failed", "The result of this chapter could not be saved."],
        ["done", null],
      ]);
    });

    it("carries on even when recording a failure also throws", async () => {
      const id = h.addBook(2);
      vi.spyOn(h.queue, "markDone").mockImplementationOnce(() => {
        throw new Error("disk I/O error");
      });
      vi.spyOn(h.queue, "markFailed").mockImplementationOnce(() => {
        throw new Error("disk I/O error again");
      });

      h.start(stubConverter(ok));

      await until(() => h.status(id, 2) === "done");
      // Left generating; the next start puts it back in the h.queue.
      expect(h.status(id, 1)).toBe("generating");
      expect(h.bookStatus(id)).toBe("converting");
    });

    it("does not let a failing status refresh stop the worker", async () => {
      const first = h.addBook(1);
      const second = h.addBook(1);
      h.start(stubConverter(ok));
      vi.spyOn(h.queue, "refreshBookStatus").mockImplementationOnce(() => {
        throw new Error("busy");
      });

      await until(() => h.status(second, 1) === "done");
      expect(h.status(first, 1)).toBe("done");
    });

    it("sleeps when idle and wakes on notify", async () => {
      const converter = stubConverter(ok);
      const p = h.start(converter);
      await tick();
      expect(converter.convert).not.toHaveBeenCalled();

      const id = h.addBook(1);
      p.notify();

      await until(() => h.bookStatus(id) === "done");
    });

    it("re-queues chapters left generating by a restart and keeps their chunks", async () => {
      const id = h.addBook(2);
      const task = h.queue.claimNext(); // as if the previous process died mid-chapter
      if (!task) throw new Error("expected a chapter");
      h.queue.recordChunks(task, 3, 7);
      let resumedWith: { chunksDone: number; chunkCount: number } | undefined;

      h.start(
        stubConverter(async (run) => {
          if (run.task.position === 1) resumedWith = run.task;
          return ok(run);
        }),
      );

      await until(() => h.bookStatus(id) === "done");
      expect(resumedWith).toMatchObject({ chunksDone: 3, chunkCount: 7, claim: 2 });
    });

    it("settles a book that finished right before the restart", async () => {
      const id = h.addBook(1);
      const task = h.queue.claimNext();
      if (!task) throw new Error("expected a chapter");
      h.queue.markDone(task, "a.webm", 1);

      h.start(stubConverter(ok));

      await until(() => h.bookStatus(id) === "done");
      expect(h.repo.chapter(id, 1)).toMatchObject({ status: "done", audioPath: "a.webm" });
    });

    it("puts the running chapter back in the queue on stop, keeping its chunks", async () => {
      const id = h.addBook(1);
      const converter = stubConverter(async (run) => {
        run.saveProgress(2, 5);
        await h.gates.hold(run);
        throw new TtsError("aborted", "Conversion was cancelled");
      });
      const p = h.start(converter);
      await until(() => h.gates.open.length === 1);

      await p.stop();

      expect(h.repo.chapter(id, 1)).toMatchObject({
        status: "queued",
        chunksDone: 2,
        chunkCount: 5,
        error: null,
      });
      expect(h.bookStatus(id)).toBe("converting");
      expect(converter.discardChunks).not.toHaveBeenCalled();
      expect(p.status().activeWorkers).toBe(0);
    });

    it("can be started again after stop", async () => {
      const p = h.start(stubConverter(ok));
      await p.stop();
      const id = h.addBook(1);

      p.start();

      await until(() => h.bookStatus(id) === "done");
      expect(h.repo.chapter(id, 1)?.status).toBe("done");
    });

    it("discards the chunks of a finished chapter but keeps those of a failed one", async () => {
      const id = h.addBook(2);
      const converter = stubConverter(async (run) => {
        if (run.task.position === 2) throw new TtsError("synthesis_failed", "no");
        return ok(run);
      });

      h.start(converter);

      await until(() => h.bookStatus(id) === "done_with_errors");
      expect(converter.discardChunks.mock.calls.map(([task]) => task.position)).toEqual([1]);
      expect(converter.discardAudio).not.toHaveBeenCalled();
    });
  });
});
