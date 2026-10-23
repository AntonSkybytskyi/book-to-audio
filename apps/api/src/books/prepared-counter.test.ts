import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareChunks, prepareInThread, type TextPreparer } from "../convert/chapter-text.js";
import type { AppEvent } from "../events/bus.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { TtsError } from "../tts/engine.js";
import { CountRepository } from "./count-repository.js";
import { Limiter } from "./limiter.js";
import { PreparedCounter, type CounterDeps } from "./prepared-counter.js";
import { BookRepository } from "./repository.js";

/** A preparer a test releases by hand, one text at a time. */
const gated = () => {
  const waiting: { text: string; language: string; release: () => void }[] = [];
  const prepare: TextPreparer = (text, language) =>
    new Promise((resolve) =>
      waiting.push({
        text,
        language,
        release: () => resolve(prepareChunks(text, language, 400)),
      }),
    );
  return { prepare, waiting };
};

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

describe("PreparedCounter", () => {
  let ctx: TestContext;
  let repo: BookRepository;
  let events: AppEvent[];

  beforeEach(() => {
    ctx = createTestContext();
    repo = new BookRepository(ctx.db);
    events = [];
    ctx.bus.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    await Promise.all(made.splice(0).map((c) => c.stop()));
    ctx.cleanup();
  });

  const made: PreparedCounter[] = [];
  const counter = (
    prepare: TextPreparer = prepareInThread,
    limiter?: Limiter,
    more: Partial<CounterDeps> = {},
  ) => {
    const c = new PreparedCounter({
      repo: new CountRepository(ctx.db),
      prepare,
      maxChars: 400,
      bus: ctx.bus,
      limiter,
      retryDelaysMs: [],
      ...more,
    });
    made.push(c);
    return c;
  };

  const add = (id: string, language: string, texts: string[], status = "ready") => {
    repo.insert(
      { id, title: id, author: null, language, coverMime: null, coverPath: null, sourcePath: "s" },
      texts.map((text, i) => ({ title: `C${i}`, text, wordCount: 1 })),
    );
    ctx.db.prepare("UPDATE books SET status = ? WHERE id = ?").run(status, id);
  };
  const stored = (id: string) =>
    ctx.db
      .prepare("SELECT prepared_chars FROM chapters WHERE book_id = ? ORDER BY position")
      .pluck()
      .all(id);
  const counted = () => events.filter((e) => e.type === "book-counted");

  it("counts the chapters of a book in the background, and tells the pages", async () => {
    add("a", "en", ["It cost $15.", "Second."]);
    const c = counter();

    c.enqueue("a");
    expect(stored("a")).toEqual([null, null]); // the caller was not kept waiting

    await c.whenIdle();
    expect(stored("a")).toEqual([prepareChunks("It cost $15.", "en", 400).join("").length, 7]);
    expect(counted()).toEqual([{ type: "book-counted", bookId: "a" }]);
  });

  it("uses the language of the book", async () => {
    add("uk", "uk", ["Було 3 яблука."]);
    const c = counter();

    c.enqueue("uk");
    await c.whenIdle();

    expect(stored("uk")).toEqual([prepareChunks("Було 3 яблука.", "uk", 400).join("").length]);
  });

  it("does nothing for a book that is not there", async () => {
    const c = counter();

    c.enqueue("nope");
    await c.whenIdle();

    expect(events).toEqual([]);
  });

  it("starts no more than the allowed number of rules at once, across books", async () => {
    add("a", "en", ["One.", "Two.", "Three."]);
    add("b", "en", ["Four.", "Five.", "Six."]);
    const gate = gated();
    const c = counter(gate.prepare, new Limiter(2));

    c.enqueue("a");
    c.enqueue("b");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(gate.waiting).toHaveLength(2); // one text of each book; each book counts one chapter at a time
    gate.waiting[0]?.release();
    gate.waiting[1]?.release();
    for (let i = 0; i < 20 && stored("a").includes(null); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      gate.waiting.splice(0).forEach((w) => w.release());
    }
    await c.whenIdle();
    expect(stored("a")).not.toContain(null);
    expect(stored("b")).not.toContain(null);
  });

  it("counts the rest of a book by its raw length once the rules gave up", async () => {
    add("a", "en", ["bad one", "fine two", "fine three"]);
    let calls = 0;
    const c = counter(async (text) => {
      calls++;
      throw new TtsError("bad_input", `took too long on ${text}`);
    });

    c.enqueue("a");
    await c.whenIdle();

    expect(stored("a")).toEqual([7, 8, 10]);
    expect(calls).toBe(1);
    expect(counted()).toHaveLength(1);
  });

  it("drops the result when the book was deleted meanwhile", async () => {
    add("a", "en", ["One.", "Two."]);
    const gate = gated();
    const c = counter(gate.prepare);

    c.enqueue("a");
    await new Promise((resolve) => setTimeout(resolve, 5));
    ctx.db.prepare("DELETE FROM books WHERE id = 'a'").run();
    gate.waiting[0]?.release();
    await c.whenIdle();

    expect(counted()).toEqual([]);
    expect(gate.waiting).toHaveLength(1); // no second chapter was started
  });

  it("drops a count for the old language when the language changed, and counts the new one", async () => {
    add("a", "en", ["Hello 5."]);
    const gate = gated();
    const c = counter(gate.prepare);

    c.enqueue("a"); // counting in en
    await new Promise((resolve) => setTimeout(resolve, 5));
    repo.setLanguage("a", "uk");
    c.enqueue("a"); // counting in uk, started while the first is still going
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gate.waiting.map((w) => w.language)).toEqual(["en", "uk"]);
    gate.waiting[1]?.release(); // the new one finishes first
    await new Promise((resolve) => setTimeout(resolve, 5));
    gate.waiting[0]?.release(); // and the old one, late
    await c.whenIdle();

    expect(stored("a")).toEqual([prepareChunks("Hello 5.", "uk", 400).join("").length]);
    expect(counted()).toHaveLength(1);
  });

  it("does not count a book twice for the same language at the same time", async () => {
    add("a", "en", ["One."]);
    const gate = gated();
    const c = counter(gate.prepare);

    c.enqueue("a");
    c.enqueue("a");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(gate.waiting).toHaveLength(1);
    gate.waiting[0]?.release();
    await c.whenIdle();
  });

  it("counts every unfinished book that is missing a count when it backfills", async () => {
    add("a", "en", ["One."]);
    add("b", "en", ["Two."], "done");
    add("c", "uk", ["Три."], "converting");
    const c = counter();

    c.backfill();
    await c.whenIdle();

    expect(stored("a")).not.toContain(null);
    expect(stored("b")).toEqual([null]);
    expect(stored("c")).not.toContain(null);
  });

  it("stops what is under way and takes no more work after stop()", async () => {
    add("a", "en", ["One.", "Two."]);
    const gate = gated();
    const c = counter(gate.prepare);
    c.enqueue("a");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const stopping = c.stop();
    gate.waiting[0]?.release();
    await stopping;
    c.enqueue("a");
    await c.whenIdle();

    expect(stored("a")).toEqual([null, null]);
    expect(counted()).toEqual([]);
    expect(gate.waiting).toHaveLength(1);
  });

  it("marks what the rules gave up on as approximate, and the book is still usable", async () => {
    add("a", "en", ["bad one", "fine two"]);
    const c = counter(async () => {
      throw new TtsError("bad_input", "took too long");
    });

    c.enqueue("a");
    await c.whenIdle();

    expect(
      ctx.db.prepare("SELECT prepared_approx FROM chapters ORDER BY position").pluck().all(),
    ).toEqual([1, 1]);
    expect(repo.chapters("a").every((chapter) => chapter.counted)).toBe(true);
  });

  describe("trying again", () => {
    it("counts a book again later when it was only counted approximately, and then stops", async () => {
      add("a", "en", ["One.", "Two."]);
      let rulesWork = false;
      let runs = 0;
      const c = counter(
        async (text, language, max) => {
          runs++;
          if (!rulesWork) throw new TtsError("bad_input", "took too long");
          return prepareChunks(text, language, max);
        },
        undefined,
        { retryDelaysMs: [5, 5] },
      );

      c.enqueue("a");
      await c.whenIdle();
      expect(stored("a")).toEqual([4, 4]); // stand-ins
      rulesWork = true;
      await tick();
      await c.whenIdle();

      expect(stored("a")).toEqual([4, 4]); // "One." is 4 characters prepared too
      expect(ctx.db.prepare("SELECT prepared_approx FROM chapters").pluck().all()).toEqual([0, 0]);
      const after = runs;
      await tick(40);
      expect(runs).toBe(after); // nothing more is scheduled once it was exact
    });

    it("gives up after the bounded number of tries", async () => {
      add("a", "en", ["One."]);
      let runs = 0;
      const c = counter(
        async () => {
          runs++;
          throw new TtsError("bad_input", "took too long");
        },
        undefined,
        { retryDelaysMs: [3, 3] },
      );

      c.enqueue("a");
      for (let i = 0; i < 20; i++) {
        await tick(8);
        await c.whenIdle();
      }

      expect(runs).toBe(3); // the first try and two more
    });

    it("tries again after a failure that was not about the text, such as a busy database", async () => {
      add("a", "en", ["One."]);
      const real = new CountRepository(ctx.db);
      let failures = 1;
      const c = counter(prepareInThread, undefined, {
        repo: {
          bookLanguage: (id) => real.bookLanguage(id),
          pending: (id) => {
            if (failures-- > 0) throw new Error("database is locked");
            return real.pending(id);
          },
          setCounts: (...args) => real.setCounts(...args),
          uncountedBookIds: () => real.uncountedBookIds(),
        },
        retryDelaysMs: [5],
        logger: { warn: () => {} },
      });

      c.enqueue("a");
      await c.whenIdle();
      expect(stored("a")).toEqual([null]);
      await tick();
      await c.whenIdle();

      expect(stored("a")).toEqual([4]);
      expect(counted()).toHaveLength(1);
    });

    it("does not retry a book that was deleted, and stop() cancels the timers", async () => {
      add("a", "en", ["One."]);
      const c = counter(
        async () => {
          throw new TtsError("bad_input", "took too long");
        },
        undefined,
        { retryDelaysMs: [5] },
      );
      c.enqueue("a");
      await c.whenIdle();
      ctx.db.prepare("DELETE FROM books WHERE id = 'a'").run();
      await tick();
      await c.whenIdle();
      expect(counted()).toHaveLength(1); // nothing came of the retry

      add("b", "en", ["Two."]);
      const d = counter(
        async () => {
          throw new TtsError("bad_input", "took too long");
        },
        undefined,
        { retryDelaysMs: [5] },
      );
      d.enqueue("b");
      await d.whenIdle();
      await d.stop();
      const seen = counted().length;
      await tick();
      expect(counted().length).toBe(seen);
    });
  });

  describe("the time budget of a book", () => {
    it("does not charge a book for waiting behind others, so a backfill does not leave raw counts behind", async () => {
      add("slow", "en", ["One."]);
      add("b", "en", ["Two."]);
      add("c", "en", ["Three."]);
      let now = 0;
      const waiting: (() => void)[] = [];
      const prepare: TextPreparer = (text, language, max) =>
        new Promise((resolve) =>
          waiting.push(() => {
            now += 1000; // each book's rules take a second of the fake clock
            resolve(prepareChunks(text, language, max));
          }),
        );
      const c = counter(prepare, new Limiter(1), { budget: { ms: 1500, now: () => now } });

      c.backfill(); // all three at once; one rule run at a time
      for (let i = 0; i < 30 && c.busy; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3));
        waiting.splice(0).forEach((release) => release());
      }
      await c.whenIdle();

      // Book c waited through 2,000 ms of the others' work, more than its 1,500 ms budget, and is exact.
      expect(ctx.db.prepare("SELECT prepared_approx FROM chapters").pluck().all()).toEqual([
        0, 0, 0,
      ]);
      expect(counted()).toHaveLength(3);
    });

    it("does give up on a book whose own rules ran past the budget", async () => {
      add("a", "en", ["One.", "Two.", "Three."]);
      let now = 0;
      const c = counter(
        async (text, language, max) => {
          now += 1000;
          return prepareChunks(text, language, max);
        },
        undefined,
        { budget: { ms: 1500, now: () => now } },
      );

      c.enqueue("a");
      await c.whenIdle();

      expect(
        ctx.db.prepare("SELECT prepared_approx FROM chapters ORDER BY position").pluck().all(),
      ).toEqual([0, 0, 1]);
    });
  });

  it("says when it has no count left under way", async () => {
    add("a", "en", ["One."]);
    let idle = 0;
    const c = counter(prepareInThread, undefined, { onIdle: () => idle++ });

    c.enqueue("a");
    await c.whenIdle();

    expect(idle).toBe(1);
    expect(c.busy).toBe(false);
  });

  it("logs and carries on when counting breaks", async () => {
    add("a", "en", ["One."]);
    const warnings: object[] = [];
    const c = counter(prepareInThread, undefined, {
      repo: {
        bookLanguage: () => "en",
        pending: () => {
          throw new Error("disk");
        },
        setCounts: () => false,
        uncountedBookIds: () => [],
      },
      logger: { warn: (context) => warnings.push(context) },
    });

    c.enqueue("a");
    await c.whenIdle();

    expect(warnings).toHaveLength(1);
  });
});
