import { describe, expect, it } from "vitest";
import { countPrepared } from "../books/prepared-chars.js";
import { prepareChunks, prepareInThread, type TextPreparer } from "../convert/chapter-text.js";
import { lighthouseBook } from "../epub/testing/sample-books.js";
import { ukrainianBook } from "../epub/testing/sample-books-languages.js";
import { useEstimatesHarness } from "../testing/estimates-harness.js";
import type { BookJson } from "../testing/estimates-harness.js";

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("estimates in the API", () => {
  const h = useEstimatesHarness();
  const texts = () =>
    h.ctx.db.prepare("SELECT text FROM chapters ORDER BY position").pluck().all() as string[];
  const stored = (id: string) =>
    h.ctx.db
      .prepare("SELECT prepared_chars FROM chapters WHERE book_id = ? ORDER BY position")
      .pluck()
      .all(id);

  const patch = (id: string, language: string) =>
    h.app.inject({ method: "PATCH", url: `/api/books/${id}`, payload: { language } });

  describe("at upload", () => {
    it("answers at once, before the text is counted, and says it is still measuring", async () => {
      const gate: { release: () => void } = { release: () => {} };
      h.rebuild({
        prepareText: (text) =>
          new Promise((resolve) => {
            gate.release = () => resolve([text]);
          }),
      });

      const book = await h.upload(await lighthouseBook(), { settle: false });

      expect(book).toMatchObject({ measuring: true, estimate: null });
      expect(stored(book.id).every((n) => n === null)).toBe(true);
      expect(book.chapters.every((c) => c.estimatedSeconds === null)).toBe(true);
      gate.release();
    });

    it("tells the pages when the counting is done, and then the estimate is there", async () => {
      h.benchmarked();
      const seen: string[] = [];
      h.ctx.bus.subscribe((event) => seen.push(event.type));

      const book = await h.upload(await lighthouseBook());

      expect(seen).toEqual(["book-added", "book-counted"]);
      expect(book.measuring).toBe(false);
      expect(book.estimate?.source).toBe("benchmark");
    });

    it("stores the characters the engine will be given, which is not the raw length", async () => {
      const book = await h.upload(await ukrainianBook());

      const expected = await countPrepared(
        texts(),
        "uk",
        h.ctx.engine.maxInputChars,
        prepareInThread,
      );
      expect(book.chapters.map((c) => c.preparedChars)).toEqual(expected);
      // Ukrainian spells out every number, so the text grows.
      expect(book.chapters.some((c, i) => c.preparedChars !== texts()[i]?.length)).toBe(true);
    });

    it("keeps the counts in the database, so later requests do not run the text rules", async () => {
      const book = await h.upload(await lighthouseBook());

      expect(stored(book.id)).toEqual(book.chapters.map((c) => c.preparedChars));
    });

    it("gives the audio length from the speech rate of the voice, and marks a guess as rough", async () => {
      const rough = await h.upload(await lighthouseBook());
      expect(rough.estimate?.source).toBe("rough");

      h.benchmarked();
      const book = await h.read(rough.id);

      const chars = book.chapters.reduce((sum, c) => sum + c.preparedChars, 0);
      expect(book.estimate?.source).toBe("benchmark");
      expect(book.estimate?.audioSeconds).toBeCloseTo((chars / 1000) * 60, 6);
      expect(book.chapters[0]?.estimatedSeconds).toBeCloseTo(
        (book.chapters[0]!.preparedChars / 1000) * 60,
        6,
      );
      expect(book.speed?.secondsPerKChar).toBe(60);
    });

    it("tells how long converting takes with the workers in use, from the measured throughput", async () => {
      h.benchmarked();
      const book = await h.upload(await lighthouseBook());

      const one = (await h.read(book.id)).estimate!;
      await h.app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { workers: { fake: 2 } },
      });
      const two = (await h.read(book.id)).estimate!;

      expect(one.workers).toBe(1);
      expect(two.workers).toBe(2);
      expect(one.convertSeconds).toBeGreaterThan(one.audioSeconds / 20);
      expect(two.convertSeconds).toBeLessThan(one.convertSeconds);
    });

    it("is in the library list too, for a book that is not converted yet", async () => {
      h.benchmarked();
      const book = await h.upload(await lighthouseBook());

      const listed = (await h.library()).find((b) => b.id === book.id);

      expect(listed?.estimate?.audioSeconds).toBe((await h.read(book.id)).estimate?.audioSeconds);
      expect(listed?.timeLeft).toBeNull();
    });

    it("has no estimate for a language the engine has no voice for", async () => {
      const book = await h.upload(await lighthouseBook());
      h.ctx.db.prepare("UPDATE books SET language = 'ru' WHERE id = ?").run(book.id);

      const body = await h.read(book.id);

      expect(body.estimate).toBeNull();
      expect(body.speed).toBeNull();
      expect(body.chapters.every((c) => c.estimatedSeconds === null)).toBe(true);
    });

    it("counts a chapter whose text cannot be prepared at its raw length instead of failing the upload", async () => {
      h.rebuild({
        prepareText: async () => {
          throw new Error("text rules ran too long");
        },
      });

      const book = await h.upload(await lighthouseBook());

      expect(book.chapters.map((c) => c.preparedChars)).toEqual(
        book.chapters.map((c) => c.charCount),
      );
      expect(book.measuring).toBe(false);
    });
  });

  describe("when the language changes", () => {
    it("answers at once with the counts forgotten, and counts again for the new language", async () => {
      const book = await h.upload(await ukrainianBook());
      const before = book.chapters.map((c) => c.preparedChars);

      const res = await patch(book.id, "en");

      expect(res.json<BookJson>()).toMatchObject({ language: "en", measuring: true });
      await h.counter.whenIdle();
      const after = (await h.read(book.id)).chapters.map((c) => c.preparedChars);
      expect(after).toEqual(
        await countPrepared(texts(), "en", h.ctx.engine.maxInputChars, prepareInThread),
      );
      expect(after).not.toEqual(before);
    });

    it("does not count again when the language stays", async () => {
      const book = await h.upload(await ukrainianBook());
      h.ctx.db.prepare("UPDATE chapters SET prepared_chars = 7").run();

      const res = await patch(book.id, "uk");

      expect(res.json<BookJson>().chapters.every((c) => c.preparedChars === 7)).toBe(true);
      expect(res.json<BookJson>().measuring).toBe(false);
    });

    it("keeps the counts of the language that is current when two changes finish out of order", async () => {
      let gating = false;
      const waiting: { language: string; release: () => void }[] = [];
      const slow: TextPreparer = (text, language) =>
        gating
          ? new Promise((resolve) =>
              waiting.push({
                language,
                release: () => resolve(prepareChunks(text, language, 400)),
              }),
            )
          : prepareInThread(text, language, 400);
      h.rebuild({ prepareText: slow });
      const book = await h.upload(await lighthouseBook());
      gating = true;

      await patch(book.id, "uk");
      await tick();
      await patch(book.id, "en");
      await tick();
      expect(waiting.map((w) => w.language)).toEqual(["uk", "en"]);
      // The newer count (en) finishes first, chapter by chapter; the stale one (uk) comes in last.
      const [stale] = waiting.splice(0, 1);
      for (let i = 0; i < 30 && h.counter.busy; i++) {
        waiting.splice(0).forEach((w) => w.release());
        await tick(3);
      }
      stale?.release();
      await h.counter.whenIdle();

      const body = await h.read(book.id);
      expect(body.language).toBe("en");
      expect(body.measuring).toBe(false);
      expect(body.chapters.map((c) => c.preparedChars)).toEqual(
        await countPrepared(texts(), "en", 400, prepareInThread),
      );
    });
  });

  describe("GET /api/books/:id/estimate", () => {
    it("gives the book's own estimate for its own language", async () => {
      h.benchmarked();
      const book = await h.upload(await lighthouseBook());

      const body = (await h.estimate(book.id, "en")).json<{
        estimate: BookJson["estimate"];
        chapterSeconds: number[];
        measuring: boolean;
      }>();

      expect(body.estimate).toEqual((await h.read(book.id)).estimate);
      expect(body.measuring).toBe(false);
      expect(body.chapterSeconds).toEqual(
        (await h.read(book.id)).chapters.map((c) => c.estimatedSeconds),
      );
    });

    it("says it is still measuring while the book's own text is not counted", async () => {
      h.rebuild({ prepareText: () => new Promise(() => {}) });
      const book = await h.upload(await lighthouseBook(), { settle: false });

      const body = (await h.estimate(book.id, "en")).json();

      expect(body).toMatchObject({ estimate: null, chapterSeconds: [], measuring: true });
    });

    it("reads the book as if it were in another language, with that language's speech rate and text", async () => {
      h.benchmarked();
      const book = await h.upload(await ukrainianBook());

      const body = (await h.estimate(book.id, "en")).json<{
        estimate: NonNullable<BookJson["estimate"]>;
        speed: BookJson["speed"];
        chapterSeconds: number[];
      }>();

      const chars = texts().map(
        (t) => prepareChunks(t, "en", h.ctx.engine.maxInputChars).join("").length,
      );
      expect(body.speed?.secondsPerKChar).toBe(60);
      expect(body.chapterSeconds[0]).toBeCloseTo(((chars[0] ?? 0) / 1000) * 60, 1);
      expect(body.estimate.audioSeconds).toBeCloseTo(
        body.chapterSeconds.reduce((a, b) => a + b, 0),
        6,
      );
    });

    it("changes nothing about the book, which stays in its own language until it is converted", async () => {
      const book = await h.upload(await ukrainianBook());
      const before = book.chapters.map((c) => c.preparedChars);

      await h.estimate(book.id, "en");

      const after = await h.read(book.id);
      expect(after.language).toBe("uk");
      expect(after.chapters.map((c) => c.preparedChars)).toEqual(before);
    });

    it("works the text out once for requests that arrive together", async () => {
      h.benchmarked();
      let runs = 0;
      h.rebuild({
        prepareText: async (text, language, max) => {
          runs++;
          await tick(2);
          return prepareChunks(text, language, max);
        },
      });
      const book = await h.upload(await ukrainianBook());
      const chapters = book.chapters.length;
      runs = 0;

      const replies = await Promise.all([1, 2, 3, 4].map(() => h.estimate(book.id, "en")));

      expect(replies.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
      expect(runs).toBe(chapters);
    });

    it("refuses new languages while too many are being worked out, and says to try again", async () => {
      h.rebuild({ prepareText: () => new Promise(() => {}) });
      const ids: string[] = [];
      for (let i = 0; i < 4; i++)
        ids.push((await h.upload(await lighthouseBook(), { settle: false })).id);

      const pending = ids.slice(0, 3).map((id) => h.estimate(id, "uk"));
      await tick();
      const refused = await h.estimate(ids[3]!, "uk");

      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ error: "busy" });
      void pending;
    });

    it("has nothing to say for a language without a voice", async () => {
      const book = await h.upload(await ukrainianBook());

      const body = (await h.estimate(book.id, "ru")).json();

      expect(body).toMatchObject({ estimate: null, speed: null, chapterSeconds: [] });
    });

    it("refuses an unknown language, a bad id, an unknown book and a book that was converted", async () => {
      const book = await h.upload(await lighthouseBook());

      expect((await h.estimate(book.id, "xx")).statusCode).toBe(400);
      expect((await h.app.inject(`/api/books/nope/estimate?language=en`)).statusCode).toBe(400);
      expect(
        (await h.app.inject(`/api/books/00000000-0000-4000-8000-000000000000/estimate?language=en`))
          .statusCode,
      ).toBe(404);
      await h.convert(book.id);
      expect((await h.estimate(book.id, "en")).statusCode).toBe(409);
    });

    it("is refused when another site asks", async () => {
      const book = await h.upload(await lighthouseBook());

      const res = await h.app.inject({
        method: "GET",
        url: `/api/books/${book.id}/estimate?language=uk`,
        headers: { "sec-fetch-site": "cross-site" },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
