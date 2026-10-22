import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../testing/context.js";
import { CountRepository } from "./count-repository.js";
import { BookRepository } from "./repository.js";

const approx = (...chars: number[]) =>
  chars.map((count, i) => ({ position: i + 1, chars: count, approx: true }));

const exact = (...chars: number[]) =>
  chars.map((count, i) => ({ position: i + 1, chars: count, approx: false }));

describe("counting prepared text in the database", () => {
  let ctx: TestContext;
  let repo: BookRepository;
  let counts: CountRepository;

  beforeEach(() => {
    ctx = createTestContext();
    repo = new BookRepository(ctx.db);
    counts = new CountRepository(ctx.db);
  });

  afterEach(() => ctx.cleanup());

  const add = (id: string, language: string, status: "ready" | "done", texts: string[]) => {
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

  describe("setCounts", () => {
    it("saves the counts in reading order", () => {
      add("a", "en", "ready", ["One.", "Two."]);

      expect(counts.setCounts("a", "en", exact(10, 20))).toBe(true);

      expect(stored("a")).toEqual([10, 20]);
      expect(repo.chapters("a").map((c) => [c.preparedChars, c.counted])).toEqual([
        [10, true],
        [20, true],
      ]);
    });

    it("drops counts made for another language than the book is in now", () => {
      add("a", "uk", "ready", ["One."]);

      expect(counts.setCounts("a", "en", exact(10))).toBe(false);

      expect(stored("a")).toEqual([null]);
    });

    it("does not overwrite a count that is already there", () => {
      add("a", "en", "ready", ["One."]);
      counts.setCounts("a", "en", exact(10));

      counts.setCounts("a", "en", exact(99));

      expect(stored("a")).toEqual([10]);
    });

    it("saves nothing for a book that is gone", () => {
      expect(counts.setCounts("nope", "en", exact(1))).toBe(false);
      expect(counts.bookLanguage("nope")).toBeUndefined();
    });

    it("forgets the counts when the owner picks another language, and keeps them when it stays", () => {
      add("a", "en", "ready", ["One.", "Two."]);
      counts.setCounts("a", "en", exact(10, 20));

      repo.setLanguage("a", "en");
      expect(stored("a")).toEqual([10, 20]);
      repo.setLanguage("a", "uk");

      expect(stored("a")).toEqual([null, null]);
      expect(counts.bookLanguage("a")).toBe("uk");
    });

    it("drops a late count for the old language after the change, and takes the new one", () => {
      add("a", "en", "ready", ["One."]);
      repo.setLanguage("a", "uk");
      repo.setLanguage("a", "ru");

      expect(counts.setCounts("a", "uk", exact(11))).toBe(false); // the slow first one, finishing last
      expect(counts.setCounts("a", "ru", exact(22))).toBe(true);

      expect(stored("a")).toEqual([22]);
    });
  });

  describe("approximate counts", () => {
    it("keeps a stand-in that is the raw length usable, but still to be counted", () => {
      add("a", "en", "ready", ["One.", "Two."]);

      counts.setCounts("a", "en", approx(4, 4));

      expect(repo.chapters("a").map((c) => [c.preparedChars, c.counted])).toEqual([
        [4, true],
        [4, true],
      ]);
      expect(counts.pending("a").map((c) => c.position)).toEqual([1, 2]);
      expect(counts.uncountedBookIds()).toEqual(["a"]);
    });

    it("lets an exact count replace a stand-in, and never the other way round", () => {
      add("a", "en", "ready", ["One.", "Two."]);
      counts.setCounts("a", "en", [
        { position: 1, chars: 4, approx: true },
        { position: 2, chars: 9, approx: false },
      ]);

      counts.setCounts("a", "en", exact(11, 99));
      expect(stored("a")).toEqual([11, 9]);
      counts.setCounts("a", "en", approx(1, 1));
      expect(stored("a")).toEqual([11, 9]);
      expect(counts.pending("a")).toEqual([]);
      expect(counts.uncountedBookIds()).toEqual([]);
    });

    it("forgets stand-ins when the language changes or the rules do", () => {
      add("a", "en", "ready", ["One."]);
      counts.setCounts("a", "en", approx(4));
      repo.setLanguage("a", "uk");
      expect(counts.pending("a")).toHaveLength(1);
      expect(stored("a")).toEqual([null]);

      counts.setCounts("a", "uk", approx(4));
      counts.resetCountsIfRulesChanged(1);
      expect(stored("a")).toEqual([null]);
      expect(ctx.db.prepare("SELECT prepared_approx FROM chapters").pluck().get()).toBe(0);
    });
  });

  describe("uncountedBookIds", () => {
    it("lists unfinished books with a missing count, and not finished ones", () => {
      add("a", "en", "ready", ["One."]);
      add("b", "en", "done", ["One."]);
      add("c", "en", "ready", ["One."]);
      counts.setCounts("c", "en", exact(4));

      expect(counts.uncountedBookIds()).toEqual(["a"]);
    });
  });

  describe("resetCountsIfRulesChanged", () => {
    it("forgets the counts of unfinished books once when the version changes", () => {
      add("a", "en", "ready", ["One."]);
      add("b", "en", "done", ["One."]);
      counts.setCounts("a", "en", exact(4));
      ctx.db.prepare("UPDATE chapters SET prepared_chars = 4 WHERE book_id = 'b'").run();

      expect(counts.resetCountsIfRulesChanged(3)).toBe("recorded"); // first time: nothing was recorded
      expect(stored("a")).toEqual([null]);
      expect(stored("b")).toEqual([4]); // finished books keep what they have
      counts.setCounts("a", "en", exact(4));
      expect(counts.resetCountsIfRulesChanged(3)).toBe("same");
      expect(stored("a")).toEqual([4]);
      expect(counts.resetCountsIfRulesChanged(4)).toBe("changed");
      expect(stored("a")).toEqual([null]);
    });
  });

  describe("workload", () => {
    it("lists the books that are not finished, earliest queued first and ready ones last, with chapters in order", () => {
      add("old", "en", "done", ["x"]);
      add("ready", "en", "ready", ["One."]);
      add("second", "en", "ready", ["A.", "B."]);
      add("first", "uk", "ready", ["C."]);
      repo.queue("first");
      ctx.db
        .prepare("UPDATE books SET queued_at = '2026-01-01T00:00:00.000Z' WHERE id = 'first'")
        .run();
      repo.queue("second");
      ctx.db
        .prepare("UPDATE books SET queued_at = '2026-01-02T00:00:00.000Z' WHERE id = 'second'")
        .run();
      ctx.db
        .prepare(
          "UPDATE chapters SET prepared_chars = 10 WHERE book_id = 'second' AND position = 2",
        )
        .run();

      const load = repo.workload();

      expect(load.map((b) => [b.bookId, b.status, b.language])).toEqual([
        ["first", "converting", "uk"],
        ["second", "converting", "en"],
        ["ready", "ready", "en"],
      ]);
      expect(load[1]?.chapters).toEqual([
        { status: "queued", progress: 0, preparedChars: 2, counted: false }, // the raw length stands in
        { status: "queued", progress: 0, preparedChars: 10, counted: true },
      ]);
    });

    it("includes paused books and nothing else", () => {
      add("p", "en", "ready", ["One."]);
      repo.queue("p");
      ctx.db.prepare("UPDATE books SET status = 'paused' WHERE id = 'p'").run();
      add("e", "en", "ready", ["One."]);
      ctx.db.prepare("UPDATE books SET status = 'done_with_errors' WHERE id = 'e'").run();

      expect(repo.workload().map((b) => b.bookId)).toEqual(["p"]);
    });
  });
});
