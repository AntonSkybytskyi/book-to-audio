import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { type BookControlsDeps } from "../books/controls.js";
import {
  controlsFor,
  finishAll as finishAllOf,
  gatedConverter,
  key,
  writeParts as writePartsOf,
} from "../testing/controls-harness.js";
import { PoolStateStore } from "./pool-state.js";
import { ok, result, stubConverter, tick, until, usePoolHarness } from "../testing/pool-harness.js";
import { TtsError } from "../tts/engine.js";
import type { ChapterRun } from "./convert-chapter.js";

const failRun = (nth: number) => {
  let runs = 0;
  return stubConverter(async (run) => {
    if (++runs === nth) throw new TtsError("synthesis_failed", "The engine failed.");
    return result(run.task);
  });
};

describe("regenerate a chapter with a running pool", () => {
  const h = usePoolHarness();
  const controls = (extra?: Partial<BookControlsDeps>) => controlsFor(h, extra);
  const gated = (onRun?: (run: ChapterRun) => void) => gatedConverter(h, onRun);
  const finishAll = (id: string) => finishAllOf(h, id);
  const writeParts = (id: string, position: number) => writePartsOf(h, id, position);
  it("queues a finished chapter again, keeps its audio, and replaces it when done", async () => {
    const id = h.addBook(1);
    let version = 0;
    const p = h.start(
      stubConverter(async (run) => {
        if (++version === 2) await h.gates.hold(run);
        return result(run.task);
      }),
    );
    await finishAll(id);
    expect(h.repo.chapter(id, 1)?.audioVersion).toBe(1);
    expect(h.repo.audioGeneration(id)).toBe(1);

    await controls().regenerateChapter(id, 1);
    await until(() => h.gates.open.length === 1);

    // Being regenerated: the old audio is still there and still playable.
    expect(h.repo.chapter(id, 1)).toMatchObject({
      status: "generating",
      audioPath: `audio/${id}/1.webm`,
      audioVersion: 1,
    });
    expect(h.bookStatus(id)).toBe("converting");
    expect(h.repo.audioGeneration(id)).toBe(1);
    h.gates.releaseAll();
    await finishAll(id);
    expect(h.repo.chapter(id, 1)?.audioVersion).toBe(2);
    expect(h.repo.audioGeneration(id)).toBe(2);
    expect(p.status().state).toBe("running");
  });

  it("stops a running chapter, discards its chunks and starts again at 0", async () => {
    const id = h.addBook(1);
    let attempts = 0;
    const seen: { done: number; total: number }[] = [];
    const parts = writeParts(id, 1);
    h.start(
      gated((run) => {
        seen.push({ done: run.task.chunksDone, total: run.task.chunkCount });
        if (++attempts === 1) run.saveProgress(3, 6);
      }),
    );
    await until(() => h.gates.open.length === 1);
    expect(h.repo.chapter(id, 1)?.chunksDone).toBe(3);

    await controls().regenerateChapter(id, 1);
    await until(() => attempts === 2);

    expect(fs.existsSync(parts)).toBe(false);
    expect(seen).toEqual([
      { done: 0, total: 0 },
      { done: 0, total: 0 },
    ]);
    expect(h.repo.chapter(id, 1)).toMatchObject({ chunksDone: 0, status: "generating" });
  });

  it("drops the result of the attempt it stopped, even if that attempt finishes anyway", async () => {
    const id = h.addBook(1);
    let attempts = 0;
    h.start(
      stubConverter(async (run) => {
        const mine = ++attempts;
        await h.gates.hold(run);
        return mine === 1 ? result(run.task) : ok(run);
      }),
    );
    await until(() => h.gates.open.length === 1);

    await controls().regenerateChapter(id, 1);

    expect(h.repo.chapter(id, 1)?.audioPath).toBeNull();
    expect(h.repo.chapter(id, 1)?.audioVersion).toBe(0);
    await until(() => attempts === 2);
    h.gates.releaseAll();
    await finishAll(id);
    expect(h.repo.chapter(id, 1)?.audioVersion).toBe(1);
  });

  it("continues a failed chapter from its saved chunks", async () => {
    const id = h.addBook(1);
    const seen: number[] = [];
    let attempts = 0;
    const parts = writeParts(id, 1);
    h.start(
      stubConverter(async (run) => {
        seen.push(run.task.chunksDone);
        if (++attempts === 1) {
          run.saveProgress(2, 5);
          throw new TtsError("bad_input", "Cannot read this.");
        }
        return result(run.task);
      }),
    );
    await until(() => h.status(id, 1) === "failed");
    expect(h.bookStatus(id)).toBe("done_with_errors");

    await controls().regenerateChapter(id, 1);

    await finishAll(id);
    expect(seen).toEqual([0, 2]);
    expect(fs.existsSync(parts)).toBe(true); // the stub converter does not clean up
  });

  it("does nothing for a chapter that is already waiting", async () => {
    const id = h.addBook(2);
    h.start(gated());
    await until(() => h.gates.open.length === 1);
    h.events.length = 0;

    await controls().regenerateChapter(id, 2);

    expect(h.events.filter((e) => e.type === "chapter")).toEqual([]);
    expect(h.status(id, 2)).toBe("queued");
  });

  it("refuses a book that is not converted, a chapter that does not exist and a missing book", async () => {
    const ready = h.addBook(1, false);
    const id = h.addBook(1);
    h.start(gated());
    const c = controls();

    await expect(c.regenerateChapter(ready, 1)).rejects.toMatchObject({ status: 409 });
    await expect(c.regenerateChapter(id, 9)).rejects.toMatchObject({ status: 404 });
    await expect(c.regenerateChapter(crypto.randomUUID(), 1)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("brings a finished book back to converting", async () => {
    const id = h.addBook(1);
    let runs = 0;
    h.start(
      stubConverter(async (run) => {
        if (++runs === 2) await h.gates.hold(run);
        return result(run.task);
      }),
    );
    await finishAll(id);

    await controls().regenerateChapter(id, 1);
    await until(() => h.gates.open.length === 1);
    expect(h.bookStatus(id)).toBe("converting");

    h.gates.releaseAll();
    await finishAll(id);
    expect(h.repo.chapter(id, 1)?.audioVersion).toBe(2);
  });

  it("keeps a paused book paused", async () => {
    const id = h.addBook(2);
    h.start(stubConverter(ok));
    await finishAll(id);
    h.ctx.db.prepare("UPDATE books SET status = 'paused' WHERE id = ?").run(id);

    await controls().regenerateChapter(id, 1);
    await tick();
    await tick();

    expect(h.status(id, 1)).toBe("queued");
    expect(h.bookStatus(id)).toBe("paused");
  });

  it("does not clear a paused pool", async () => {
    const id = h.addBook(3);
    const p = h.start(
      stubConverter(async () => {
        throw new TtsError("synthesis_failed", "Engine down.");
      }),
    );
    await until(() => p.status().services[0]?.state === "paused");
    await until(() => h.repo.chapters(id).filter((c) => c.status === "failed").length === 3);

    await controls().regenerateChapter(id, 1);
    await tick();
    await tick();

    expect(p.status().services[0]?.state).toBe("paused");
    expect(h.status(id, 1)).toBe("queued");
  });

  it("publishes the chapter and the book", async () => {
    const id = h.addBook(1);
    h.start(stubConverter(ok));
    await finishAll(id);
    h.events.length = 0;

    await controls().regenerateChapter(id, 1);

    expect(h.events[0]).toMatchObject({ type: "chapter", status: "queued", position: 1 });
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "book", status: "converting", doneCount: 0 }),
    );
  });

  it("makes the chapter that was regenerated while running the next one to run", async () => {
    const id = h.addBook(3);
    h.start(gated());
    await until(() => h.gates.open.includes(key(id, 1)));
    h.gates.release(key(id, 1));
    await until(() => h.gates.open.includes(key(id, 2)));
    expect(h.gates.started).toEqual([key(id, 1), key(id, 2)]);

    await controls().regenerateChapter(id, 2);

    // The one worker took chapter 2 again, not chapter 3 which was waiting before it.
    await until(() => h.gates.started.length === 3);
    expect(h.gates.started).toEqual([key(id, 1), key(id, 2), key(id, 2)]);
    expect(h.status(id, 3)).toBe("queued");
  });

  it("is claimed before the waiting chapters with two workers as well", async () => {
    const id = h.addBook(4);
    h.start(gated(), 2);
    await until(() => h.gates.open.length === 2);

    await controls().regenerateChapter(id, 2);

    await until(() => h.gates.started.length === 3);
    expect(h.gates.started.slice(2)).toEqual([key(id, 2)]);
  });

  describe("a regeneration that fails", () => {
    it("puts a finished chapter back to done with its audio and a note, and the book stays done", async () => {
      const id = h.addBook(2);
      const converter = failRun(3); // the two chapters, then the regeneration
      h.start(converter);
      await finishAll(id);
      const before = h.repo.chapter(id, 1);
      h.events.length = 0;

      await controls().regenerateChapter(id, 1);
      await until(() => h.repo.chapter(id, 1)?.regenError !== null);
      await until(() => h.bookStatus(id) === "done");

      expect(h.repo.chapter(id, 1)).toMatchObject({
        status: "done",
        error: null,
        regenError: "The engine failed.",
        audioPath: before?.audioPath,
        audioVersion: before?.audioVersion,
        durationSeconds: 3,
      });
      expect(h.repo.get(id)).toMatchObject({ status: "done", failedCount: 0, doneCount: 2 });
      expect(h.events).toContainEqual(
        expect.objectContaining({
          type: "chapter",
          status: "done",
          progress: 1,
          regenError: "The engine failed.",
        }),
      );
      expect(converter.discardChunks).toHaveBeenCalled();
    });

    it("still counts the failure and publishes it when the chunks cannot be removed", async () => {
      const id = h.addBook(1);
      const converter = failRun(2);
      converter.discardChunks.mockImplementation(() => {
        throw new Error("EBUSY");
      });
      h.start(converter);
      await finishAll(id);
      h.events.length = 0;

      await controls().regenerateChapter(id, 1);
      await until(() => h.repo.chapter(id, 1)?.regenError !== null);

      expect(h.events).toContainEqual(
        expect.objectContaining({
          type: "chapter",
          status: "done",
          regenError: "The engine failed.",
        }),
      );
      expect(new PoolStateStore(h.ctx.db).service("fake").consecutiveFailures).toBe(1);
      expect(h.logged).toContainEqual(
        expect.objectContaining({ level: "warn", message: expect.stringContaining("chunks") }),
      );
    });

    it("clears the note when the chapter is regenerated again", async () => {
      const id = h.addBook(1);
      h.start(failRun(2));
      await finishAll(id);
      await controls().regenerateChapter(id, 1);
      await until(() => h.repo.chapter(id, 1)?.regenError !== null);

      await controls().regenerateChapter(id, 1);
      await until(() => h.bookStatus(id) === "done" && h.repo.chapter(id, 1)?.audioVersion === 2);

      expect(h.repo.chapter(id, 1)).toMatchObject({ status: "done", regenError: null });
    });
  });

  describe("when something goes wrong while the chapter is held", () => {
    it("leaves a chapter alone when the worker that was given up on settles later", async () => {
      const id = h.addBook(1);
      let releaseStuck: (() => void) | undefined;
      let runs = 0;
      h.start(
        stubConverter(async (run) => {
          if (++runs === 1) {
            // Ignores the abort, like a stuck child process.
            await new Promise<void>((resolve) => {
              releaseStuck = resolve;
            });
          }
          return result(run.task);
        }),
        2,
      );
      await until(() => runs === 1);
      await expect(controls({ abortTimeoutMs: 20 }).regenerateChapter(id, 1)).rejects.toThrow(
        "did not stop",
      );
      // The other worker takes the chapter and finishes it.
      await until(() => h.bookStatus(id) === "done");
      const claimBefore = h.ctx.db.prepare("SELECT claim FROM chapters").pluck().get();
      const remove = vi.spyOn(h.ctx.storage, "removeParts");
      h.events.length = 0;

      releaseStuck?.();
      await until(() => h.pool?.status().activeWorkers === 0);
      await tick();

      // The abandoned request does not run its restart: nothing was reset, removed or announced.
      expect(remove).not.toHaveBeenCalled();
      expect(h.status(id, 1)).toBe("done");
      expect(h.ctx.db.prepare("SELECT claim FROM chapters").pluck().get()).toBe(claimBefore);
      expect(h.repo.chapter(id, 1)?.audioVersion).toBe(1);
      expect(h.events.filter((e) => e.type === "chapter")).toEqual([]);
    });

    it("puts a running chapter back in the queue when its chunks cannot be removed", async () => {
      const id = h.addBook(1);
      h.start(gated());
      await until(() => h.gates.open.length === 1);
      vi.spyOn(h.ctx.storage, "removeParts").mockImplementationOnce(() => {
        throw new Error("EBUSY");
      });

      await expect(controls().regenerateChapter(id, 1)).rejects.toThrow("EBUSY");

      // Not stranded as generating with nobody working on it: a worker takes it again.
      await until(() => h.gates.started.length === 2);
      expect(h.status(id, 1)).toBe("generating");
      h.gates.releaseAll();
      await finishAll(id);
    });

    it("puts a finished chapter's state back when its chunks cannot be removed", async () => {
      const id = h.addBook(1);
      h.start(stubConverter(ok));
      await finishAll(id);
      vi.spyOn(h.ctx.storage, "removeParts").mockImplementationOnce(() => {
        throw new Error("EACCES");
      });

      await expect(controls().regenerateChapter(id, 1)).rejects.toThrow("EACCES");

      expect(h.status(id, 1)).toBe("done");
    });

    it("gives up on a worker that does not stop, and queues the chapter anyway", async () => {
      const id = h.addBook(1);
      let release: (() => void) | undefined;
      let runs = 0;
      h.start(
        stubConverter(async (run) => {
          if (++runs === 1) {
            // Ignores the abort, like a stuck child process.
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return result(run.task);
        }),
      );
      await until(() => runs === 1);

      await expect(controls({ abortTimeoutMs: 20 }).regenerateChapter(id, 1)).rejects.toThrow(
        "did not stop",
      );

      expect(h.status(id, 1)).toBe("queued");
      release?.(); // the stuck attempt ends later; its result is dropped
      await until(() => h.bookStatus(id) === "done");
      expect(h.repo.chapter(id, 1)?.audioVersion).toBe(1);
    });
  });
});
