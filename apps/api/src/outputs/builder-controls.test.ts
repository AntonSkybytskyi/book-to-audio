import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { OutputBuilder } from "./builder.js";
import { OutputRepository } from "./repository.js";
import { ScriptedProducer } from "../testing/outputs-harness.js";
import { controlsFor, finishAll, gatedConverter, key } from "../testing/controls-harness.js";
import { ok, stubConverter, tick, until, usePoolHarness } from "../testing/pool-harness.js";
import { toOutputsView } from "./view.js";

/** The real pool, book controls and output builder together, with only the encoders scripted. */
describe("downloads and book controls", () => {
  const h = usePoolHarness();
  let active: OutputBuilder | undefined;
  let producer: ScriptedProducer;

  const setup = (converter = stubConverter(ok)) => {
    producer = new ScriptedProducer();
    h.start(converter, 1);
    const builder = new OutputBuilder({
      books: h.repo,
      outputs: new OutputRepository(h.ctx.db),
      storage: h.ctx.storage,
      producer,
      bus: h.ctx.bus,
      progressIntervalMs: 0,
    });
    active = builder;
    const controls = controlsFor(h, { outputs: builder });
    return { controls, builder };
  };
  const view = (id: string) => {
    const book = h.repo.get(id);
    if (!book) throw new Error("no book");
    return toOutputsView(book.status, book.audioGeneration, book.outputs);
  };

  afterEach(async () => {
    producer.hold = false;
    await active?.stop();
    active = undefined;
  });

  it("builds by itself when the pool finishes the last chapter", async () => {
    const { builder } = setup();
    builder.start();
    producer.hold = false;
    const id = h.addBook(2);

    await finishAll(h, id);
    await until(() => view(id).available);

    expect(producer.started).toEqual([id]);
    expect(view(id)).toMatchObject({ state: "ready", available: true });
    expect(fs.existsSync(h.ctx.storage.outputFile(id, "m4b"))).toBe(true);
  });

  it("does not build a book that finished with a failed chapter", async () => {
    const { builder } = setup(
      stubConverter(async (run) => {
        if (run.task.position === 2) throw new Error("boom");
        return ok(run);
      }),
    );
    builder.start();
    producer.hold = false;
    const id = h.addBook(2);

    // The pool announces the final status; the builder looks at it in a microtask after that.
    await until(() =>
      h.events.some((e) => e.type === "book" && e.bookId === id && e.status === "done_with_errors"),
    );
    await tick();

    expect(producer.started).toEqual([]);
    expect(h.repo.get(id)?.outputs).toBeNull();
  });

  it("cancels a running build when the book is deleted, and leaves no files", async () => {
    const { controls, builder } = setup();
    builder.start();
    const id = h.addBook(2);
    await finishAll(h, id);
    await until(() => producer.isRunning(id));
    const job = producer.jobs[0];
    expect(fs.existsSync(job?.workDir ?? "")).toBe(true);

    await controls.delete(id);

    expect(job?.signal.aborted).toBe(true);
    expect(producer.isRunning(id)).toBe(false);
    expect(builder.isBusy(id)).toBe(false);
    expect(fs.existsSync(h.ctx.storage.outputsDir(id))).toBe(false);
    expect(fs.existsSync(h.ctx.storage.bookDir(id))).toBe(false);
    expect(h.ctx.db.prepare("SELECT count(*) FROM book_outputs").pluck().get()).toBe(0);
    // Nothing about this book is published after it was deleted.
    const deletedAt = h.events.findIndex((e) => e.type === "book-deleted");
    expect(h.events.slice(deletedAt + 1).filter((e) => "bookId" in e && e.bookId === id)).toEqual(
      [],
    );
  });

  it("removes the downloads of a book that was deleted after they were built", async () => {
    const { controls, builder } = setup();
    builder.start();
    producer.hold = false;
    const id = h.addBook(1);
    await finishAll(h, id);
    await until(() => view(id).available);

    await controls.delete(id);

    expect(fs.existsSync(h.ctx.storage.outputsDir(id))).toBe(false);
  });

  it("cancels a build when a chapter is regenerated, and builds again from the new audio", async () => {
    const { controls, builder } = setup();
    builder.start();
    const id = h.addBook(2);
    await finishAll(h, id);
    await until(() => producer.isRunning(id));
    const first = producer.jobs[0];
    const before = h.repo.audioGeneration(id);

    producer.hold = false;
    await controls.regenerateChapter(id, 1);

    expect(first?.signal.aborted).toBe(true);
    await until(() => view(id).available);
    expect(h.repo.audioGeneration(id)).toBeGreaterThan(before);
    expect(h.repo.get(id)?.outputs?.builtGeneration).toBe(h.repo.audioGeneration(id));
    expect(producer.started).toEqual([id, id]);
  });

  it("withdraws the downloads at once when a chapter is regenerated, then offers the new ones", async () => {
    const { controls, builder } = setup(gatedConverter(h));
    builder.start();
    producer.hold = false;
    const id = h.addBook(2);
    await until(() => h.gates.open.length === 1);
    h.gates.releaseAll();
    await until(() => h.gates.open.length === 1);
    h.gates.releaseAll();
    await finishAll(h, id);
    await until(() => view(id).available);
    const firstBuild = h.repo.get(id)?.outputs?.builtGeneration;

    await controls.regenerateChapter(id, 2);
    await until(() => h.gates.open.includes(key(id, 2)));

    // The chapter is being read again: the old files are not offered, and the page can say so.
    expect(view(id)).toMatchObject({ available: false, updating: true, m4bBytes: null });
    expect(h.bookStatus(id)).toBe("converting");

    h.gates.releaseAll();
    await finishAll(h, id);
    await until(() => view(id).available);
    expect(h.repo.get(id)?.outputs?.builtGeneration).toBeGreaterThan(firstBuild ?? 0);
    expect(producer.started).toHaveLength(2);
  });

  it("keeps the downloads when a regeneration of a finished chapter fails and the book is done again", async () => {
    let runs = 0;
    const { controls, builder } = setup(
      stubConverter(async (run) => {
        if (++runs === 3) throw new Error("boom");
        return ok(run);
      }),
    );
    builder.start();
    producer.hold = false;
    const id = h.addBook(2);
    await finishAll(h, id);
    await until(() => view(id).available);

    await controls.regenerateChapter(id, 1);
    await until(() => h.bookStatus(id) === "done");
    await until(() => h.repo.chapter(id, 1)?.regenError !== null);

    // Its old audio stayed and nothing was written, so the files built from it are still current.
    expect(view(id)).toMatchObject({ available: true });
    expect(producer.started).toHaveLength(1);
  });
});
