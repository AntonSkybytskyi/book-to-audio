import { describe, expect, it } from "vitest";
import { PoolStateStore } from "../convert/pool-state.js";
import { lighthouseBook, rainBook } from "../epub/testing/sample-books.js";
import { CHAPTER_OVERHEAD_SECONDS } from "../speed/calibration.js";
import { useEstimatesHarness } from "../testing/estimates-harness.js";

describe("time left in the API", () => {
  const h = useEstimatesHarness();

  it("is given for a converting book, and counts a running chapter by what is left of it", async () => {
    h.benchmarked();
    const book = await h.upload(await lighthouseBook());
    await h.convert(book.id);
    const chapters = (await h.read(book.id)).chapters;
    h.setChapters(book.id, [
      ["done", 1],
      ["generating", 0.5],
      ["queued", 0],
      ["failed", 0],
    ]);

    const { timeLeft } = await h.read(book.id);

    const left = ((chapters[1]!.preparedChars / 2 + chapters[2]!.preparedChars) / 1000) * 60;
    expect(timeLeft).toMatchObject({ state: "running", booksAhead: 0, source: "benchmark" });
    // Two chapters left and one worker: all at 20 audio s/s, plus the overhead of each.
    expect(timeLeft?.remainingSeconds).toBeCloseTo(left / 20 + 2 * CHAPTER_OVERHEAD_SECONDS, 3);
  });

  it("goes down as the chapters progress", async () => {
    h.benchmarked();
    const book = await h.upload(await lighthouseBook());
    await h.convert(book.id);
    h.setChapters(book.id, [
      ["generating", 0.1],
      ["queued", 0],
      ["queued", 0],
      ["queued", 0],
    ]);
    const early = (await h.read(book.id)).timeLeft!.remainingSeconds!;

    h.setChapters(book.id, [
      ["done", 1],
      ["generating", 0.6],
      ["queued", 0],
      ["queued", 0],
    ]);
    const later = (await h.read(book.id)).timeLeft!.remainingSeconds!;

    expect(later).toBeLessThan(early);
  });

  it("has the second book wait for the first and says how long, in the library as well", async () => {
    h.benchmarked();
    const first = await h.upload(await lighthouseBook());
    const second = await h.upload(await rainBook());
    await h.convert(first.id);
    await h.convert(second.id);
    h.setChapters(first.id, [
      ["generating", 0],
      ["queued", 0],
      ["queued", 0],
      ["queued", 0],
    ]);

    const books = await h.library();
    const wait = books.find((b) => b.id === second.id)?.timeLeft;
    const lead = books.find((b) => b.id === first.id)?.timeLeft;

    expect(lead).toMatchObject({ state: "running", booksAhead: 0, startsInSeconds: null });
    expect(wait).toMatchObject({ state: "waiting", booksAhead: 1 });
    expect(wait?.startsInSeconds).toBeCloseTo(lead!.remainingSeconds!, 6);
  });

  it("says paused for a paused book, and for every book while the pool is paused", async () => {
    h.benchmarked();
    const book = await h.upload(await lighthouseBook());
    await h.convert(book.id);
    await h.app.inject({ method: "POST", url: `/api/books/${book.id}/pause` });

    expect((await h.read(book.id)).timeLeft).toMatchObject({
      state: "paused",
      remainingSeconds: null,
    });
    await h.app.inject({ method: "POST", url: `/api/books/${book.id}/resume` });
    expect((await h.read(book.id)).timeLeft?.state).toBe("running");
    new PoolStateStore(h.ctx.db).pause("failures", "broken");

    expect((await h.read(book.id)).timeLeft).toMatchObject({
      state: "pool_paused",
      remainingSeconds: null,
    });
    expect((await h.library()).find((b) => b.id === book.id)?.timeLeft?.state).toBe("pool_paused");
  });

  it("is gone once the book is done", async () => {
    h.benchmarked();
    const book = await h.upload(await lighthouseBook());
    await h.convert(book.id);
    h.setChapters(book.id, [
      ["done", 1],
      ["done", 1],
      ["done", 1],
      ["done", 1],
    ]);
    h.ctx.db.prepare("UPDATE books SET status = 'done' WHERE id = ?").run(book.id);

    const body = await h.read(book.id);

    expect(body.timeLeft).toBeNull();
    expect(body.estimate).toBeNull();
  });

  it("follows what was learned: slower chapters make the time left longer", async () => {
    h.benchmarked();
    const book = await h.upload(await lighthouseBook());
    await h.convert(book.id);
    const before = (await h.read(book.id)).timeLeft!.remainingSeconds!;

    h.ctx.db
      .prepare(
        "INSERT INTO speed_learning (engine, voice_id, seconds_per_kchar, slowdown, samples) VALUES ('fake', 'fake-en', 60, 2, 5)",
      )
      .run();
    const after = await h.read(book.id);

    expect(after.timeLeft?.remainingSeconds).toBeCloseTo(before * 2, 6);
    expect(after.timeLeft?.source).toBe("learned");
  });
});
