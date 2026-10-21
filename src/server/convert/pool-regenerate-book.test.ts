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
import { result, stubConverter, until, usePoolHarness } from "../testing/pool-harness.js";
import type { ChapterRun } from "./convert-chapter.js";

describe("regenerate a book with a running pool", () => {
  const h = usePoolHarness();
  const controls = (extra?: Partial<BookControlsDeps>) => controlsFor(h, extra);
  const gated = (onRun?: (run: ChapterRun) => void) => gatedConverter(h, onRun);
  const finishAll = (id: string) => finishAllOf(h, id);
  const writeParts = (id: string, position: number) => writePartsOf(h, id, position);
  it("stops running chapters, discards every chunk and queues all chapters again", async () => {
    const id = h.addBook(3);
    let runs = 0;
    const parts = [1, 2, 3].map((position) => writeParts(id, position));
    h.start(
      gated(() => {
        runs++;
      }),
      2,
    );
    await until(() => h.gates.open.length === 2);

    await controls().regenerateBook(id);

    expect(parts.map((dir) => fs.existsSync(dir))).toEqual([false, false, false]);
    await until(() => runs === 4);
    expect(h.repo.chapters(id).every((c) => c.chunksDone === 0)).toBe(true);
    expect(h.bookStatus(id)).toBe("converting");
  });

  it("keeps the old audio of every chapter until its new one replaces it", async () => {
    const id = h.addBook(2);
    let round = 1;
    h.start(
      stubConverter(async (run) => {
        if (round === 2) await h.gates.hold(run);
        return result(run.task);
      }),
    );
    await finishAll(id);
    round = 2;

    await controls().regenerateBook(id);
    await until(() => h.gates.open.length === 1);

    expect(h.repo.chapters(id).map((c) => c.audioPath)).toEqual([
      `audio/${id}/1.webm`,
      `audio/${id}/2.webm`,
    ]);
    expect(h.repo.chapters(id).map((c) => c.status)).toEqual(["generating", "queued"]);
    h.gates.releaseAll();
    await until(() => h.gates.open.length === 1);
    h.gates.releaseAll();
    await finishAll(id);
    expect(h.repo.chapters(id).map((c) => c.audioVersion)).toEqual([2, 2]);
  });

  it("refuses a book that is not converted", async () => {
    const ready = h.addBook(1, false);
    h.start(gated());

    await expect(controls().regenerateBook(ready)).rejects.toMatchObject({ status: 409 });
  });

  it("runs one operation on a book after the other", async () => {
    const id = h.addBook(2);
    h.start(gated());
    await until(() => h.gates.open.length === 1);
    const c = controls();

    const results = await Promise.allSettled([
      c.regenerateBook(id),
      c.regenerateBook(id),
      c.pause(id),
      c.resume(id),
    ]);

    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(h.bookStatus(id)).toBe("converting");
  });

  it("does nothing when every chapter is already waiting and nothing is done yet", async () => {
    const id = h.addBook(3);
    const p = h.start(gated());
    await until(() => h.gates.open.length === 1);
    await p.stop(); // chapter 1 goes back to the queue
    const abort = vi.spyOn(p, "abortBook");
    const remove = vi.spyOn(h.ctx.storage, "removeParts");
    h.events.length = 0;

    await controls().regenerateBook(id);

    expect(abort).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(h.events.filter((e) => e.type === "chapter")).toEqual([]);
  });

  it("puts everything back in the queue when chunks cannot be removed", async () => {
    const id = h.addBook(3);
    h.start(gated(), 2);
    await until(() => h.gates.open.length === 2);
    vi.spyOn(h.ctx.storage, "removeParts").mockImplementationOnce(() => {
      throw new Error("EBUSY");
    });

    await expect(controls().regenerateBook(id)).rejects.toThrow("EBUSY");

    // Chapters 1 and 2 are taken again by the two workers: nothing is held with nobody on it.
    await until(() => h.gates.started.length === 4);
    expect(h.repo.chapters(id).map((c) => c.status)).toEqual([
      "generating",
      "generating",
      "queued",
    ]);
  });

  it("deletes a book whose worker does not stop, and answers within the time limit", async () => {
    const id = h.addBook(1);
    let release: (() => void) | undefined;
    h.start(
      stubConverter(async (run) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return result(run.task);
      }),
    );
    await until(() => release !== undefined);
    const warn = vi.fn<(context: object, message: string) => void>();

    await controls({ abortTimeoutMs: 20, logger: { warn } }).delete(id);

    expect(h.repo.get(id)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith({ bookId: id }, expect.stringContaining("did not stop"));
    expect(h.events.at(-1)).toEqual({ type: "book-deleted", bookId: id });
    release?.();
  });

  it("leaves finished and failed chapters alone when the request fails part way", async () => {
    const id = h.addBook(3);
    h.start(gated());
    await until(() => h.gates.open.includes(key(id, 1)));
    h.gates.release(key(id, 1)); // chapter 1 is done; chapter 2 is running and 3 waits
    await until(() => h.gates.open.includes(key(id, 2)));
    expect(h.status(id, 1)).toBe("done");
    // A chapter that failed earlier, to see that it is not queued again either.
    h.ctx.db.prepare("UPDATE chapters SET status = 'failed', error = 'x' WHERE position = 3").run();
    vi.spyOn(h.ctx.storage, "removeParts").mockImplementationOnce(() => {
      throw new Error("EBUSY");
    });

    await expect(controls().regenerateBook(id)).rejects.toThrow("EBUSY");

    expect(h.status(id, 1)).toBe("done");
    expect(h.repo.chapter(id, 1)?.audioVersion).toBe(1);
    expect(h.status(id, 3)).toBe("failed");
    // The chapter that was running is back in the queue, and taken again.
    await until(() => h.gates.started.length === 3);
    expect(h.gates.started).toEqual([key(id, 1), key(id, 2), key(id, 2)]);
  });
});
