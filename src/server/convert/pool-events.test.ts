import { describe, expect, it } from "vitest";
import { ok, stubConverter, until, usePoolHarness } from "../testing/pool-harness.js";
import { TtsError } from "../tts/engine.js";

describe("WorkerPool: events", () => {
  const h = usePoolHarness();

  describe("events", () => {
    it("publishes chapter, book and pool events", async () => {
      const id = h.addBook(1);

      h.start(stubConverter(ok));
      await until(() => h.bookStatus(id) === "done");

      const chapter = h.events.filter((e) => e.type === "chapter");
      expect(chapter.map((e) => e.type === "chapter" && e.status)).toEqual([
        "generating",
        "generating",
        "done",
      ]);
      expect(chapter.at(-1)).toMatchObject({
        bookId: id,
        position: 1,
        progress: 1,
        durationSeconds: 3,
      });
      expect(h.events).toContainEqual({
        type: "book",
        bookId: id,
        status: "done",
        doneCount: 1,
        failedCount: 0,
        durationSeconds: 3,
      });
      expect(h.events).toContainEqual({
        type: "pool",
        state: "running",
        error: null,
        cause: null,
        workers: 1,
        activeWorkers: 1,
      });
    });

    it("publishes the failure with its message and the pause", async () => {
      h.addBook(3);

      h.start(
        stubConverter(async () => {
          throw new TtsError("synthesis_failed", "Engine down.");
        }),
      );
      await until(() => h.pool?.status().state === "paused");

      expect(h.events).toContainEqual(
        expect.objectContaining({ type: "chapter", status: "failed", error: "Engine down." }),
      );
      expect(h.events).toContainEqual(
        expect.objectContaining({ type: "pool", state: "paused", error: "Engine down." }),
      );
    });

    it("publishes a pool event when the worker count or the pause changes", () => {
      const p = h.start(stubConverter(ok));
      h.events.length = 0;

      p.setWorkers(2);
      p.resume();

      expect(h.events.map((e) => e.type)).toEqual(["pool", "pool"]);
      expect(h.events[0]).toMatchObject({ workers: 2 });
    });

    it("publishes a chapter that goes back to the queue with the progress it kept", async () => {
      h.addBook(1);
      const p = h.start(
        stubConverter(async (run) => {
          run.saveProgress(1, 4);
          await h.gates.hold(run);
          throw new TtsError("aborted", "x");
        }),
      );
      await until(() => h.gates.open.length === 1);

      await p.stop();

      expect(h.events).toContainEqual(
        expect.objectContaining({ type: "chapter", status: "queued", progress: 0.25 }),
      );
    });
  });
});
