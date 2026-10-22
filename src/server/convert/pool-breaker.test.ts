import { describe, expect, it } from "vitest";
import {
  failing,
  ok,
  stubConverter,
  tick,
  until,
  usePoolHarness,
} from "../testing/pool-harness.js";
import { TtsError } from "../tts/engine.js";
import { DiskFullError } from "../errors.js";
import { PoolStateStore } from "./pool-state.js";

const full = () =>
  stubConverter(async () => {
    throw new DiskFullError({ detail: "12 MB free" });
  });

describe("WorkerPool: circuit breaker", () => {
  const h = usePoolHarness();

  describe("circuit breaker", () => {
    it("pauses the pool after three chapters fail in a row", async () => {
      const id = h.addBook(5);
      const p = h.start(failing("The speech engine is broken."));

      await until(() => p.status().state === "paused");
      await tick();

      expect(p.status()).toMatchObject({ state: "paused", error: "The speech engine is broken." });
      expect(h.repo.chapters(id).map((c) => c.status)).toEqual([
        "failed",
        "failed",
        "failed",
        "queued",
        "queued",
      ]);
      expect(h.bookStatus(id)).toBe("converting"); // not finished: two chapters wait
    });

    it("is reset by a success, so only consecutive failures count", async () => {
      const id = h.addBook(6);
      h.start(
        stubConverter(async (run) => {
          if (run.task.position === 3) return ok(run);
          throw new TtsError("synthesis_failed", "no");
        }),
      );

      await until(() => h.bookStatus(id) === "done_with_errors");
      // Failed, failed, done, failed, failed, failed: the third failure after the success trips it.
      expect(h.repo.chapters(id).map((c) => c.status)).toEqual([
        "failed",
        "failed",
        "done",
        "failed",
        "failed",
        "failed",
      ]);
    });

    it("does not trip on two failures and a success", async () => {
      const id = h.addBook(5);
      h.start(
        stubConverter(async (run) => {
          if (run.task.position % 3 === 0) return ok(run);
          throw new TtsError("synthesis_failed", "no");
        }),
      );

      await until(() => h.bookStatus(id) === "done_with_errors");
      expect(h.pool?.status().state).toBe("running");
    });

    it("lets chapters that are already running finish when it trips", async () => {
      const id = h.addBook(5);
      let held = false;
      const p = h.start(
        stubConverter(async (run) => {
          if (run.task.position === 4) {
            held = true;
            await h.gates.hold(run);
            return ok(run);
          }
          throw new TtsError("synthesis_failed", "no");
        }),
        2,
      );

      // Worker 1 fails chapters 1..3 while worker 2 sits on chapter 4.
      await until(() => held && p.status().state === "paused");
      h.gates.releaseAll();

      await until(() => h.status(id, 4) === "done");
      expect(h.status(id, 5)).toBe("queued");
    });

    it("takes no new chapter while paused, and continues after resume", async () => {
      const id = h.addBook(5);
      let broken = true;
      const p = h.start(
        stubConverter(async (run) => {
          if (broken) throw new TtsError("synthesis_failed", "no");
          return ok(run);
        }),
      );
      await until(() => p.status().state === "paused");
      broken = false;
      p.notify();
      await tick();
      expect(h.status(id, 4)).toBe("queued");

      expect(p.resume()).toMatchObject({ state: "running", error: null });

      await until(() => h.status(id, 5) === "done");
      expect(h.repo.chapters(id).map((c) => c.status)).toEqual([
        "failed",
        "failed",
        "failed",
        "done",
        "done",
      ]);
      expect(h.bookStatus(id)).toBe("done_with_errors");
    });

    it("starts counting from zero after a resume", async () => {
      h.addBook(8);
      const p = h.start(failing());
      await until(() => p.status().state === "paused");

      p.resume();

      await until(() => p.status().state === "paused"); // three more failures, not one
      expect(new PoolStateStore(h.ctx.db).get().consecutiveFailures).toBe(3);
      expect(
        h.repo.chapters(h.repo.list()[0]?.id ?? "").filter((c) => c.status === "failed"),
      ).toHaveLength(6);
    });

    it("resume on a running pool changes nothing", () => {
      const p = h.start(stubConverter(ok));

      expect(p.resume()).toMatchObject({ state: "running", error: null });
    });

    it("stays paused across a restart and does not claim anything", async () => {
      const id = h.addBook(5);
      const first = h.start(failing("Broken."));
      await until(() => first.status().state === "paused");
      await first.stop();
      const converter = stubConverter(ok);

      const second = h.start(converter);
      await tick();

      expect(second.status()).toMatchObject({ state: "paused", error: "Broken." });
      expect(converter.convert).not.toHaveBeenCalled();
      expect(h.status(id, 4)).toBe("queued");
      second.resume();
      await until(() => h.status(id, 5) === "done");
    });

    it("does not count a cancelled chapter as a failure", async () => {
      h.addBook(3);
      const p = h.start(
        stubConverter(async (run) => {
          await h.gates.hold(run);
          throw new TtsError("aborted", "Conversion was cancelled");
        }),
      );
      await until(() => h.gates.open.length === 1);

      await p.stop();

      expect(new PoolStateStore(h.ctx.db).get().consecutiveFailures).toBe(0);
    });

    describe("what counts", () => {
      it("does not count text that cannot be read, however many chapters have it", async () => {
        const id = h.addBook(6);
        const p = h.start(
          stubConverter(async () => {
            throw new TtsError(
              "bad_input",
              "The speech engine could not read part of this chapter.",
            );
          }),
        );

        await until(() => h.bookStatus(id) === "done_with_errors");

        expect(h.repo.chapters(id).map((c) => c.status)).toEqual(Array(6).fill("failed"));
        expect(p.status()).toMatchObject({ state: "running", error: null });
        expect(new PoolStateStore(h.ctx.db).get().consecutiveFailures).toBe(0);
      });

      it("does not let unreadable text hide an engine that is failing", async () => {
        const id = h.addBook(6);
        const p = h.start(
          stubConverter(async (run) => {
            if (run.task.position % 2 === 0) throw new TtsError("bad_input", "unreadable");
            throw new TtsError("timeout", "The speech engine took too long.");
          }),
        );

        await until(() => p.status().state === "paused");

        // Failures 1, 3 and 5 trip it; the unreadable chapters between them neither add nor reset.
        expect(h.repo.chapters(id).map((c) => c.status)).toEqual([
          "failed",
          "failed",
          "failed",
          "failed",
          "failed",
          "queued",
        ]);
        expect(p.status()).toMatchObject({
          cause: "failures",
          error: "The speech engine took too long.",
        });
      });

      it("keeps the finished chunks of a failed chapter", async () => {
        h.addBook(1);
        const converter = stubConverter(async () => {
          throw new TtsError("synthesis_failed", "no");
        });
        h.start(converter);

        await until(
          () => h.pool?.status().activeWorkers === 0 && converter.convert.mock.calls.length === 1,
        );
        await tick();

        expect(converter.discardChunks).not.toHaveBeenCalled();
      });
    });

    describe("a full disk", () => {
      it("puts the chapter back and pauses the pool without blaming the chapter", async () => {
        const id = h.addBook(3);
        const p = h.start(full());

        await until(() => p.status().state === "paused");
        await tick();

        expect(p.status()).toMatchObject({
          state: "paused",
          cause: "disk",
          error: "The disk is almost full. Free some space, then resume.",
        });
        expect(h.repo.chapters(id).map((c) => c.status)).toEqual(["queued", "queued", "queued"]);
        expect(h.repo.chapter(id, 1)?.error).toBeNull();
        expect(new PoolStateStore(h.ctx.db).get().consecutiveFailures).toBe(0);
      });

      it("takes only one chapter while the disk is full, then continues after resume", async () => {
        const id = h.addBook(3);
        let space = false;
        const converter = stubConverter(async (run) => {
          if (!space) throw new DiskFullError();
          return ok(run);
        });
        const p = h.start(converter);
        await until(() => p.status().state === "paused");
        await tick();
        expect(converter.convert).toHaveBeenCalledTimes(1);

        space = true;
        p.resume();

        await until(() => h.bookStatus(id) === "done");
        expect(p.status()).toMatchObject({ state: "running", cause: null, error: null });
      });

      it("stays paused with its cause across a restart", async () => {
        h.addBook(2);
        const first = h.start(full());
        await until(() => first.status().state === "paused");
        await first.stop();

        const second = h.start(stubConverter(ok));

        expect(second.status()).toMatchObject({ state: "paused", cause: "disk" });
      });

      it("does not hide a disk pause behind the failure count", async () => {
        h.addBook(1);
        const p = h.start(full());
        await until(() => p.status().state === "paused");

        expect(p.status().cause).toBe("disk");
        expect(new PoolStateStore(h.ctx.db).recordFailure("late")).toBe(false); // already paused
        expect(p.status().cause).toBe("disk");
      });
    });
  });
});
