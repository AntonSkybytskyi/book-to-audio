import { describe, expect, it, vi } from "vitest";
import { ok, result, stubConverter, tick, until, usePoolHarness } from "../testing/pool-harness.js";
import { TtsError } from "../tts/engine.js";
import type { ChapterTiming } from "./pool-types.js";

const withClock = () => {
  let now = 0;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

const finishing = (clock: ReturnType<typeof withClock>, seconds = 4) =>
  stubConverter(async (run) => {
    clock.advance(seconds * 1000);
    run.saveProgress(1, 1);
    return { ...result(run.task), voiceId: "voice", preparedChars: 1200, retries: 0 };
  });

const record = () => {
  const timings: ChapterTiming[] = [];
  return { timings, learner: { recordChapter: (t: ChapterTiming) => timings.push(t) } };
};

describe("WorkerPool: holding the pool for the speed test", () => {
  const h = usePoolHarness();

  const gated = () =>
    stubConverter(async (run) => {
      await h.gates.hold(run);
      return ok(run);
    });

  describe("hold", () => {
    it("waits for the chapters being read, and lets no new one start meanwhile", async () => {
      const id = h.addBook(3);
      const pool = h.start(gated(), 1);
      await until(() => h.gates.open.length === 1);

      const holding = pool.hold();
      let held = false;
      void holding.then(() => (held = true));
      await tick();

      expect(held).toBe(false); // chapter 1 is still being read
      expect(pool.status()).toMatchObject({ held: true, activeWorkers: 1 });
      h.gates.releaseAll();
      const release = await holding;
      await tick();
      expect(h.status(id, 1)).toBe("done");
      expect(h.status(id, 2)).toBe("queued"); // the worker did not take the next chapter
      expect(h.gates.started).toHaveLength(1);
      release();
    });

    it("starts the waiting chapters as soon as the hold is released", async () => {
      const pool = h.start(gated(), 1);
      const release = await pool.hold();
      const id = h.addBook(2);
      pool.notify();
      await tick();
      expect(h.gates.started).toEqual([]);

      release();

      await until(() => h.gates.open.length === 1);
      expect(h.gates.started).toEqual([`${id.slice(0, 4)}:1`]);
    });

    it("lets a conversion queued during the hold start right after it", async () => {
      const pool = h.start(gated(), 1);
      const release = await pool.hold();
      const id = h.addBook(1); // queued while the hold is on
      pool.notify();
      await tick();
      expect(h.status(id, 1)).toBe("queued");

      release();

      await until(() => h.gates.open.length === 1);
      expect(h.status(id, 1)).toBe("generating");
    });

    it("announces the hold and its end to listeners", async () => {
      const pool = h.start(gated(), 1);
      const before = h.events.length;

      const release = await pool.hold();
      release();

      const pools = h.events.slice(before).flatMap((e) => (e.type === "pool" ? [e.held] : []));
      expect(pools).toEqual([true, false]);
      expect(pool.status().held).toBe(false);
    });

    it("keeps every worker out, not just one", async () => {
      h.addBook(6);
      const pool = h.start(gated(), 3);
      await until(() => h.gates.open.length === 3);

      const holding = pool.hold();
      h.gates.releaseAll();
      const release = await holding;
      await tick();

      expect(h.gates.started).toHaveLength(3);
      expect(pool.status().activeWorkers).toBe(0);
      release();
    });

    it("gives the pool back when the wait is cancelled", async () => {
      h.addBook(1);
      const pool = h.start(gated(), 1);
      await until(() => h.gates.open.length === 1);
      const controller = new AbortController();

      const holding = pool.hold(controller.signal);
      controller.abort(new Error("cancelled"));

      await expect(holding).rejects.toThrow("cancelled");
      expect(pool.status().held).toBe(false);
      h.gates.releaseAll();
    });

    it("works on a pool that was never started", async () => {
      h.start(gated(), 1);
      await h.pool?.stop();

      const release = await h.pool!.hold();

      expect(h.pool?.status().held).toBe(true);
      release();
    });
  });

  describe("holdWhenIdle", () => {
    it("holds at once when nothing is being read and nothing waits", async () => {
      const pool = h.start(gated(), 2);
      await tick();

      const release = await pool.holdWhenIdle();

      expect(pool.status().held).toBe(true);
      release();
    });

    it("waits while a book is converting, however many chapters it has, and takes the first quiet moment", async () => {
      const id = h.addBook(3);
      const pool = h.start(gated(), 1);
      let held = false;
      const waiting = pool.holdWhenIdle().then((release) => {
        held = true;
        return release;
      });

      for (const position of [1, 2]) {
        await until(() => h.gates.open.includes(`${id.slice(0, 4)}:${position}`));
        h.gates.release(`${id.slice(0, 4)}:${position}`);
        await tick();
        expect(held).toBe(false); // the next chapter is already queued
        expect(pool.status().held).toBe(false); // and the waiting did not hold up the conversion
      }
      await until(() => h.gates.open.includes(`${id.slice(0, 4)}:3`));
      h.gates.release(`${id.slice(0, 4)}:3`);

      const release = await waiting;
      expect(held).toBe(true);
      expect(h.status(id, 3)).toBe("done");
      release();
    });

    it("gets its turn when the last chapter ends on a worker that is being retired", async () => {
      const id = h.addBook(2);
      const pool = h.start(gated(), 2);
      await until(() => h.gates.open.length === 2);
      h.setWorkers(1); // the second worker leaves after its chapter
      let held = false;
      const waiting = pool.holdWhenIdle().then((release) => {
        held = true;
        return release;
      });

      h.gates.release(`${id.slice(0, 4)}:1`); // the staying worker finds nothing left to do
      await tick();
      expect(held).toBe(false); // the other chapter is still being read
      h.gates.release(`${id.slice(0, 4)}:2`); // and the retiring worker ends the last one

      const release = await waiting;
      expect(pool.status()).toMatchObject({ held: true, workers: 1 });
      release();
    });

    it("does not count as idle while an output build is running, and takes its turn when it ends", async () => {
      let building = true;
      const pool = h.start(gated(), 1, { busyElsewhere: () => building });
      await tick();
      let held = false;
      const waiting = pool.holdWhenIdle().then((release) => {
        held = true;
        return release;
      });

      await tick();
      expect(held).toBe(false);
      building = false;
      pool.recheckIdle();

      (await waiting)();
      expect(held).toBe(true);
    });

    it("does not wait for a paused book, which has nothing waiting to be read", async () => {
      const id = h.addBook(2);
      h.ctx.db.prepare("UPDATE books SET status = 'paused' WHERE id = ?").run(id);
      const pool = h.start(gated(), 1);
      await tick();

      const release = await pool.holdWhenIdle();

      expect(pool.status().held).toBe(true);
      release();
    });

    it("stops waiting when cancelled", async () => {
      h.addBook(1);
      const pool = h.start(gated(), 1);
      await until(() => h.gates.open.length === 1);
      const controller = new AbortController();

      const waiting = pool.holdWhenIdle(controller.signal);
      controller.abort(new Error("cancelled"));

      await expect(waiting).rejects.toThrow("cancelled");
      h.gates.releaseAll();
    });
  });

  describe("learning from finished chapters", () => {
    it("reports the voice, the length, the time it took and how many workers were busy", async () => {
      const clock = withClock();
      const { timings, learner } = record();
      const id = h.addBook(1);

      h.start(finishing(clock, 4), 1, { learner, now: clock.now });
      await until(() => h.status(id, 1) === "done");

      expect(timings).toEqual([
        {
          engine: "fake",
          voiceId: "voice",
          language: "en",
          preparedChars: 1200,
          durationSeconds: 3,
          wallSeconds: 4,
          concurrency: 1,
        },
      ]);
    });

    it("measures the average number of workers that were busy while the chapter was read", async () => {
      const clock = withClock();
      const { timings, learner } = record();
      const first = h.addBook(1);
      const second = h.addBook(1);
      const release: (() => void)[] = [];
      const converter = stubConverter(async (run) => {
        await new Promise<void>((resolve) => release.push(resolve));
        return { ...result(run.task), voiceId: "voice", preparedChars: 1200, retries: 0 };
      });

      h.start(converter, 2, { learner, now: clock.now });
      await until(() => release.length === 2); // both start at 0 ms
      clock.advance(10_000);
      release[0]?.(); // the first ends after 10 s with both busy the whole time
      await until(() => h.status(first, 1) === "done");
      clock.advance(10_000);
      release[1]?.(); // the second ran 10 s with two and 10 s alone
      await until(() => h.status(second, 1) === "done");

      expect(timings.map((t) => [t.wallSeconds, t.concurrency])).toEqual([
        [10, 2],
        [20, 1.5],
      ]);
    });

    it("does not report a chapter that continued from saved chunks", async () => {
      const { timings, learner } = record();
      const id = h.addBook(1);
      h.ctx.db.prepare("UPDATE chapters SET chunks_done = 2, chunk_count = 4").run();

      h.start(finishing(withClock()), 1, { learner });
      await until(() => h.status(id, 1) === "done");

      expect(timings).toEqual([]);
    });

    it("does not report a chapter in which a chunk had to be tried again", async () => {
      const { timings, learner } = record();
      const id = h.addBook(1);
      const converter = stubConverter(async (run) => ({
        ...result(run.task),
        voiceId: "voice",
        preparedChars: 1200,
        retries: 1,
      }));

      h.start(converter, 1, { learner });
      await until(() => h.status(id, 1) === "done");

      expect(timings).toEqual([]);
    });

    it("does not report a chapter that ran while the pool was held", async () => {
      const { timings, learner } = record();
      const id = h.addBook(1);
      const pool = h.start(gated(), 1, { learner });
      await until(() => h.gates.open.length === 1);

      const holding = pool.hold();
      h.gates.releaseAll();
      (await holding)();
      await until(() => h.status(id, 1) === "done");

      expect(timings).toEqual([]);
    });

    it("reports the next chapter, which ran with nothing disturbing it", async () => {
      const { timings, learner } = record();
      const id = h.addBook(2);
      const clock = withClock();
      const pool = h.start(finishing(clock), 1, { learner, now: clock.now });
      await until(() => h.status(id, 2) === "done");
      const before = timings.length;
      const release = await pool.hold();
      release();
      h.addBook(1);
      pool.notify();
      await until(() => timings.length > before);

      expect(timings.length).toBe(before + 1);
    });

    it("does not report a chapter without the details only the real converter gives", async () => {
      const { timings, learner } = record();
      const id = h.addBook(1);

      h.start(
        stubConverter(async (run) => result(run.task)),
        1,
        { learner },
      );
      await until(() => h.status(id, 1) === "done");

      expect(timings).toEqual([]);
    });

    it("does not report a failed or cancelled chapter", async () => {
      const { timings, learner } = record();
      const id = h.addBook(1);

      h.start(
        stubConverter(async () => {
          throw new TtsError("bad_input", "Cannot read this.");
        }),
        1,
        { learner },
      );
      await until(() => h.status(id, 1) === "failed");

      expect(timings).toEqual([]);
    });

    it("never lets a learner that fails fail the chapter", async () => {
      const learner = {
        recordChapter: vi.fn<() => void>(() => {
          throw new Error("disk full");
        }),
      };
      const id = h.addBook(2);

      h.start(finishing(withClock()), 1, { learner });
      await until(() => h.status(id, 2) === "done");

      expect(h.status(id, 1)).toBe("done");
      expect(h.bookStatus(id)).toBe("done");
      expect(h.logged.some((l) => l.message.includes("could not record how long"))).toBe(true);
    });
  });
});
