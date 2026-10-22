import { describe, expect, it } from "vitest";
import { ok, result, stubConverter, tick, until, usePoolHarness } from "../testing/pool-harness.js";
import { TtsError } from "../tts/engine.js";

describe("WorkerPool: several workers", () => {
  const h = usePoolHarness();

  // Gated chapters finish when released or aborted; an abort is reported as a cancelled attempt.
  const abortable = () =>
    stubConverter(async (run) => {
      await h.gates.hold(run);
      if (run.signal.aborted) throw new TtsError("aborted", "Conversion was cancelled");
      return ok(run);
    });
  const queuedEvents = (bookId: string) =>
    h.events
      .flatMap((e) =>
        e.type === "chapter" && e.bookId === bookId && e.status === "queued" ? [e.position] : [],
      )
      .toSorted();
  const rowId = (bookId: string, position: number) =>
    h.ctx.db
      .prepare("SELECT id FROM chapters WHERE book_id = ? AND position = ?")
      .pluck()
      .get(bookId, position) as number;

  describe("several workers", () => {
    it("keeps both workers busy on the first book before the second", async () => {
      const first = h.addBook(4);
      const second = h.addBook(2);
      const gated = stubConverter(async (run) => {
        await h.gates.hold(run);
        return ok(run);
      });

      const p = h.start(gated, 2);

      await until(() => h.gates.open.length === 2);
      const a = first.slice(0, 4);
      expect(h.gates.open.toSorted()).toEqual([`${a}:1`, `${a}:2`]);
      expect(p.status()).toMatchObject({ workers: 2, activeWorkers: 2 });

      h.gates.release(`${a}:1`);
      await until(() => h.gates.open.includes(`${a}:3`));
      h.gates.release(`${a}:2`);
      await until(() => h.gates.open.includes(`${a}:4`));
      // Book 1 has no unstarted chapters left: the next free worker moves on to book 2.
      h.gates.release(`${a}:3`);
      await until(() => h.gates.open.includes(`${second.slice(0, 4)}:1`));
      expect(h.gates.started).toEqual([
        `${a}:1`,
        `${a}:2`,
        `${a}:3`,
        `${a}:4`,
        `${second.slice(0, 4)}:1`,
      ]);
    });

    it("never gives the same chapter to two workers", async () => {
      const ids = [h.addBook(10), h.addBook(10)];
      const seen: number[] = [];

      h.start(
        stubConverter(async (run) => {
          seen.push(run.task.id);
          await new Promise((resolve) => setTimeout(resolve, 1));
          return ok(run);
        }),
        4,
      );

      await until(() => ids.every((id) => h.bookStatus(id) === "done"));
      expect(seen).toHaveLength(20);
      expect(new Set(seen).size).toBe(20);
    });

    it("takes the earliest queued book first, whatever the upload order", async () => {
      const uploadedFirst = h.addBook(1, false);
      const uploadedSecond = h.addBook(1, false);
      h.repo.queue(uploadedSecond);
      h.repo.queue(uploadedFirst);
      h.ctx.db
        .prepare("UPDATE books SET queued_at = '2031-01-01T00:00:00.000Z' WHERE id = ?")
        .run(uploadedFirst);

      h.start(
        stubConverter(async (run) => {
          await h.gates.hold(run);
          return ok(run);
        }),
        1,
      );

      await until(() => h.gates.started.length === 1);
      expect(h.gates.started).toEqual([`${uploadedSecond.slice(0, 4)}:1`]);
    });

    it("starts new workers at once when the count goes up", async () => {
      h.addBook(5);
      const p = h.start(
        stubConverter(async (run) => {
          await h.gates.hold(run);
          return ok(run);
        }),
        1,
      );
      await until(() => h.gates.open.length === 1);

      expect(p.setWorkers(3)).toMatchObject({ workers: 3 });

      await until(() => h.gates.open.length === 3);
      expect(p.status().activeWorkers).toBe(3);
    });

    it("lets extra workers finish their chapter and stop when the count goes down", async () => {
      const id = h.addBook(6);
      const engine = h.ctx.engine;
      const p = h.start(
        stubConverter(async (run) => {
          await engine.open("fake-en").then((s) => s.close());
          await h.gates.hold(run);
          return ok(run);
        }),
        3,
      );
      await until(() => h.gates.open.length === 3);

      p.setWorkers(1);

      // Nothing is cancelled: all three chapters are still running.
      expect(h.gates.open).toHaveLength(3);
      expect(p.status()).toMatchObject({ workers: 1, activeWorkers: 3 });
      h.gates.releaseAll();
      await until(() => p.status().activeWorkers <= 1);
      // Only worker 0 keeps taking chapters; the others took no new one after finishing.
      await until(() => h.gates.started.length === 4);
      await tick();
      expect(h.gates.started).toHaveLength(4);
      expect(h.gates.open).toHaveLength(1);
      expect(h.status(id, 6)).toBe("queued");
    });

    it("keeps a worker that is wanted again before it stopped", async () => {
      h.addBook(8);
      const p = h.start(
        stubConverter(async (run) => {
          await h.gates.hold(run);
          return ok(run);
        }),
        2,
      );
      await until(() => h.gates.open.length === 2);

      p.setWorkers(1);
      p.setWorkers(2);
      h.gates.releaseAll();

      await until(() => h.gates.open.length === 2); // both took a next chapter
      expect(h.gates.started).toHaveLength(4);
    });

    it("shares one failure count across workers", async () => {
      const id = h.addBook(6);
      h.start(
        stubConverter(async (run) => {
          await h.gates.hold(run);
          throw new TtsError("synthesis_failed", "The engine failed.");
        }),
        2,
      );
      await until(() => h.gates.open.length === 2);

      h.gates.releaseAll(); // two failures, on two workers
      await until(() => h.gates.started.length === 4);
      h.gates.releaseAll(); // the first of these is the third in a row

      await until(() => h.pool?.status().state === "paused");
      // Both chapters were running, so both end; nothing new starts.
      await until(() => h.repo.chapters(id).filter((c) => c.status === "failed").length === 4);
      expect(h.status(id, 5)).toBe("queued");
      expect(h.gates.started).toHaveLength(4);
    });
  });
  describe("aborting", () => {
    it("aborts one chapter by id, and resolves once the worker has put it back in the queue", async () => {
      const id = h.addBook(2);
      const p = h.start(abortable(), 2);
      await until(() => h.gates.open.length === 2);

      await p.abortChapter(rowId(id, 1));

      // Already put back in the queue when the promise resolves (a free worker then takes it again).
      expect(queuedEvents(id)).toEqual([1]);
      expect(h.repo.chapter(id, 1)?.error).toBeNull();
      expect(h.gates.open).toContain(`${id.slice(0, 4)}:2`); // the other chapter was not touched
    });

    it("aborts every running chapter of a book and leaves the other book alone", async () => {
      const first = h.addBook(2);
      const second = h.addBook(1);
      const p = h.start(abortable(), 3);
      await until(() => h.gates.open.length === 3);

      await p.abortBook(first);

      expect(queuedEvents(first)).toEqual([1, 2]);
      expect(queuedEvents(second)).toEqual([]);
      expect(h.gates.open).toContain(`${second.slice(0, 4)}:1`);
    });

    it("resolves at once when nothing of that chapter is running", async () => {
      const id = h.addBook(1, false);
      const p = h.start(abortable());

      await expect(p.abortChapter(rowId(id, 1))).resolves.toBeUndefined();
      await expect(p.abortBook(id)).resolves.toBeUndefined();
    });

    it("drops the result of an aborted chapter whose row was changed first", async () => {
      const id = h.addBook(1);
      const converter = stubConverter(async (run) => {
        await h.gates.hold(run);
        return result(run.task); // finishes anyway, as a cancelled child process might
      });
      const p = h.start(converter);
      await until(() => h.gates.open.length === 1);
      // The caller takes the chapter away first (as deleting or pausing will), then aborts.
      h.ctx.db.prepare("UPDATE chapters SET status = 'pending' WHERE book_id = ?").run(id);

      await p.abortChapter(rowId(id, 1));

      expect(h.status(id, 1)).toBe("pending");
      expect(h.repo.chapter(id, 1)?.audioPath).toBeNull();
    });

    it("wakes an idle worker for a chapter that was put back in the queue", async () => {
      const id = h.addBook(1);
      let runs = 0;
      const p = h.start(
        stubConverter(async (run) => {
          if (++runs === 1) {
            await h.gates.hold(run);
            throw new TtsError("aborted", "x");
          }
          return ok(run);
        }),
        2,
      );
      await until(() => h.gates.open.length === 1);

      await p.abortChapter(rowId(id, 1));

      // The second worker was idle; it takes the chapter without any notify.
      await until(() => h.bookStatus(id) === "done");
      expect(runs).toBe(2);
    });
  });
});
