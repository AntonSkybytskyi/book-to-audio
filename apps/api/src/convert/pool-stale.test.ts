import { describe, expect, it } from "vitest";
import { result, stubConverter, tick, until, usePoolHarness, ok } from "../testing/pool-harness.js";
import { TtsError } from "../tts/engine.js";
import { PoolStateStore } from "./pool-state.js";
import { LANGUAGES } from "../books/languages.js";

describe("WorkerPool: stale results", () => {
  const h = usePoolHarness();

  describe("stale results", () => {
    it("drops a late completion of a chapter that was re-queued and claimed again", async () => {
      const id = h.addBook(1);
      let calls = 0;
      const converter = stubConverter(async (run) => {
        if (++calls === 1) {
          await h.gates.hold(run); // the first attempt is still running...
          return result(run.task); // ...and finishes late
        }
        return ok(run);
      });
      const p = h.start(converter);
      await until(() => h.gates.open.length === 1);
      // The chapter is taken away and given to a newer attempt behind the worker's back.
      h.ctx.db.prepare("UPDATE chapters SET status = 'queued' WHERE book_id = ?").run(id);
      const newer = h.queue.claimNext(LANGUAGES);
      expect(newer?.claim).toBe(2);

      h.gates.releaseAll();
      await until(() => converter.discardAudio.mock.calls.length === 1);

      // The new attempt owns the chapter; the late one changed nothing.
      expect(h.repo.chapter(id, 1)).toMatchObject({ status: "generating", audioPath: null });
      expect(converter.discardChunks).not.toHaveBeenCalled();
      expect(p.status().state).toBe("running");
      expect(h.logged.some((l) => l.message.includes("replaced"))).toBe(true);
    });

    it("keeps the audio file when the newer attempt already finished with the same path", async () => {
      const id = h.addBook(1);
      const converter = stubConverter(async (run) => {
        await h.gates.hold(run);
        return result(run.task);
      });
      h.start(converter);
      await until(() => h.gates.open.length === 1);
      h.ctx.db.prepare("UPDATE chapters SET status = 'queued' WHERE book_id = ?").run(id);
      const newer = h.queue.claimNext(LANGUAGES);
      if (!newer) throw new Error("expected the chapter again");
      h.queue.markDone(newer, result(newer).audioPath, 3);

      h.gates.releaseAll();
      await until(() => h.logged.some((l) => l.message.includes("replaced")));

      expect(converter.discardAudio).not.toHaveBeenCalled(); // that file is the real one now
      expect(h.status(id, 1)).toBe("done");
    });

    it("does not count a late failure or let it overwrite the chapter", async () => {
      const id = h.addBook(1);
      const converter = stubConverter(async (run) => {
        await h.gates.hold(run);
        throw new TtsError("synthesis_failed", "late failure");
      });
      const p = h.start(converter);
      await until(() => h.gates.open.length === 1);
      h.ctx.db.prepare("UPDATE chapters SET status = 'queued' WHERE book_id = ?").run(id);
      h.queue.claimNext(LANGUAGES);

      h.gates.releaseAll();
      await until(() => h.logged.some((l) => l.message === "chapter failed"));
      await tick();

      expect(h.repo.chapter(id, 1)).toMatchObject({ status: "generating", error: null });
      expect(new PoolStateStore(h.ctx.db).service("fake").consecutiveFailures).toBe(0);
      expect(p.status().state).toBe("running");
    });

    it("aborts the attempt when its progress can no longer be saved", async () => {
      const id = h.addBook(1);
      let sawAbort = false;
      let saved: boolean | undefined;
      h.start(
        stubConverter(async (run) => {
          h.ctx.db.prepare("UPDATE chapters SET status = 'queued' WHERE book_id = ?").run(id);
          saved = run.saveProgress(1, 2);
          sawAbort = run.signal.aborted;
          throw new TtsError("aborted", "replaced");
        }),
      );

      await until(() => saved !== undefined);
      expect(saved).toBe(false);
      expect(sawAbort).toBe(true);
    });
  });
});
