import { describe, expect, it } from "vitest";
import { ControlError, type BookControlsDeps } from "../books/controls.js";
import {
  controlsFor,
  finishAll as finishAllOf,
  gatedConverter,
  key,
} from "../testing/controls-harness.js";
import { tick, until, usePoolHarness } from "../testing/pool-harness.js";
import type { ChapterRun } from "./convert-chapter.js";

describe("pause and resume with a running pool", () => {
  const h = usePoolHarness();
  const controls = (extra?: Partial<BookControlsDeps>) => controlsFor(h, extra);
  const gated = (onRun?: (run: ChapterRun) => void) => gatedConverter(h, onRun);
  const finishAll = (id: string) => finishAllOf(h, id);
  it("lets the running chapter finish and starts nothing else", async () => {
    const id = h.addBook(3);
    h.start(gated());
    await until(() => h.gates.open.length === 1);

    await controls().pause(id);
    expect(h.bookStatus(id)).toBe("paused");
    h.gates.release(key(id, 1));
    await until(() => h.status(id, 1) === "done");
    await tick();
    await tick();

    expect(h.gates.started).toEqual([key(id, 1)]);
    expect(h.status(id, 2)).toBe("queued");
    expect(h.bookStatus(id)).toBe("paused");
  });

  it("settles to done when the last running chapter finishes after the pause", async () => {
    const id = h.addBook(1);
    h.start(gated());
    await until(() => h.gates.open.length === 1);

    await controls().pause(id);
    h.gates.releaseAll();

    await finishAll(id);
    expect(h.bookStatus(id)).toBe("done");
  });

  it("keeps the book's place in the queue when resumed, and wakes the pool", async () => {
    const a = h.addBook(2);
    const b = h.addBook(2);
    h.start(gated());
    await until(() => h.gates.open.length === 1);
    const c = controls();

    await c.pause(a);
    h.gates.release(key(a, 1));
    await until(() => h.gates.started.includes(key(b, 1)));
    await c.resume(a);
    h.gates.release(key(b, 1));
    await until(() => h.gates.started.length === 3);
    expect(h.gates.started).toEqual([key(a, 1), key(b, 1), key(a, 2)]);
    expect(h.bookStatus(a)).toBe("converting");
  });

  it("stays paused over a restart of the pool", async () => {
    const id = h.addBook(2);
    const p = h.start(gated());
    await until(() => h.gates.open.length === 1);
    await controls().pause(id);
    h.gates.release(key(id, 1));
    await until(() => h.status(id, 1) === "done");

    await p.stop();
    h.gates.started.length = 0;
    h.start(gated());
    await tick();
    await tick();

    expect(h.gates.started).toEqual([]);
    expect(h.bookStatus(id)).toBe("paused");
  });

  it("refuses to pause a book that is not converting, and to resume one that is not paused", async () => {
    const ready = h.addBook(1, false);
    const id = h.addBook(1);
    h.start(gated());
    const c = controls();

    await expect(c.pause(ready)).rejects.toMatchObject({ status: 409 });
    await expect(c.resume(id)).rejects.toMatchObject({ status: 409 });
    await expect(c.pause(crypto.randomUUID())).rejects.toBeInstanceOf(ControlError);
    await c.pause(id);
    await expect(c.pause(id)).rejects.toMatchObject({ status: 409 });
  });

  it("publishes the book's new status", async () => {
    const id = h.addBook(2);
    h.start(gated());
    await until(() => h.gates.open.length === 1);
    h.events.length = 0;

    await controls().pause(id);

    expect(h.events).toContainEqual(expect.objectContaining({ type: "book", status: "paused" }));
  });
});
