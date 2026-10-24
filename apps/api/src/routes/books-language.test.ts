import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../app.js";
import { germanBook, russianBook, ukrainianBook } from "../epub/testing/sample-books-languages.js";
import { lighthouseBook } from "../epub/testing/sample-books.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { multipartBody } from "../testing/multipart.js";

interface BookJson {
  id: string;
  language: string;
  languageSource: string;
  languageConfidence: number;
  declaredLanguage: string | null;
}

describe("the language of an uploaded book", () => {
  let ctx: TestContext;
  let app: FastifyInstance;

  beforeEach(() => {
    ctx = createTestContext();
    app = buildServer({
      db: ctx.db,
      storage: ctx.storage,
      catalog: ctx.catalog,
      maxUploadBytes: 5 * 1024 * 1024,
      parseEpub: ctx.parseEpub,
      bus: ctx.bus,
      pool: ctx.pool,
      outputs: ctx.outputs,
      settings: ctx.settings,
    });
  });

  afterEach(async () => {
    await app.close();
    ctx.cleanup();
  });

  const convert = (id: string) => app.inject({ method: "POST", url: `/api/books/${id}/convert` });

  const upload = (filename: string, data: Buffer | string) =>
    app.inject({ method: "POST", url: "/api/books", ...multipartBody([{ filename, data }]) });

  describe("detection", () => {
    it("is found in the text and says so", async () => {
      const res = await upload("zapovit.epub", await ukrainianBook());

      expect(res.json<BookJson>()).toMatchObject({
        language: "uk",
        languageSource: "detected",
        declaredLanguage: "uk",
      });
      expect(res.json<BookJson>().languageConfidence).toBeGreaterThanOrEqual(0.7);
    });

    it("is Russian even when the book says English, and the metadata is reported", async () => {
      const res = await upload("rasskazy.epub", await russianBook("en"));

      expect(res.json<BookJson>()).toMatchObject({
        language: "ru",
        languageSource: "detected",
        declaredLanguage: "en",
      });
    });

    it("is not guessed for a German book, whatever dc:language says", async () => {
      for (const tag of ["de", "en"]) {
        const res = await upload("frosch.epub", await germanBook(tag));

        expect(res.json<BookJson>()).toMatchObject({
          language: "en",
          languageSource: "unknown",
          languageConfidence: 0,
        });
      }
    });

    it("is stored, so a reload shows the same note", async () => {
      const created = (await upload("zapovit.epub", await ukrainianBook())).json<BookJson>();

      const read = await app.inject({ url: `/api/books/${created.id}` });
      const list = await app.inject({ url: "/api/books" });

      expect(read.json<BookJson>()).toMatchObject({ language: "uk", languageSource: "detected" });
      expect(list.json<{ books: BookJson[] }>().books[0]).toMatchObject({
        languageSource: "detected",
      });
    });
  });

  describe("choosing", () => {
    it("records that the owner chose the language", async () => {
      const book = (await upload("zapovit.epub", await ukrainianBook())).json<BookJson>();
      expect(book.languageSource).toBe("detected");

      const res = await app.inject({
        method: "PATCH",
        url: `/api/books/${book.id}`,
        payload: { language: "ru" },
      });

      expect(res.json<BookJson>()).toMatchObject({
        language: "ru",
        languageSource: "chosen",
        declaredLanguage: "uk",
      });
    });
  });

  describe("converting a book whose language is not known", () => {
    it("is refused until the owner has chosen a language", async () => {
      const book = (await upload("frosch.epub", await germanBook())).json<BookJson>();
      expect(book.languageSource).toBe("unknown");

      const refused = await convert(book.id);

      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: "language_not_chosen" });
      const chosen = await app.inject({
        method: "PATCH",
        url: `/api/books/${book.id}`,
        payload: { language: "en" },
      });
      expect(chosen.json<BookJson>().languageSource).toBe("chosen");
      expect((await convert(book.id)).statusCode).toBe(202);
    });

    it("is not held up for a book whose language was detected", async () => {
      const book = (await upload("lighthouse.epub", await lighthouseBook())).json<BookJson>();

      expect((await convert(book.id)).statusCode).toBe(202);
    });
  });
});
