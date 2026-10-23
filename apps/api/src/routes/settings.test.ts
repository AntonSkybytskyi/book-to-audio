import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../app.js";
import { createTestContext, type TestContext } from "../testing/context.js";

describe("the languages setting", () => {
  let ctx: TestContext;
  let app: FastifyInstance;

  beforeEach(() => {
    ctx = createTestContext();
    app = buildServer({
      db: ctx.db,
      storage: ctx.storage,
      catalog: ctx.catalog,
      maxUploadBytes: 1024 * 1024,
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

  const patch = (payload: unknown) =>
    app.inject({ method: "PATCH", url: "/api/settings", payload: payload as object });

  describe("over the API", () => {
    it("shows English and Ukrainian until the owner changes it", async () => {
      const res = await app.inject({ url: "/api/settings" });

      expect(res.json()).toMatchObject({ shownLanguages: ["en", "uk"] });
    });

    it("saves the list, in the order of the languages, and keeps it", async () => {
      const res = await patch({ shownLanguages: ["ru", "en"] });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        shownLanguages: ["en", "ru"],
        services: [{ workers: 2 }],
      });
      expect(ctx.settings.shownLanguages()).toEqual(["en", "ru"]);
      expect((await app.inject({ url: "/api/settings" })).json()).toMatchObject({
        shownLanguages: ["en", "ru"],
      });
    });

    it("changes the languages and the workers in one request", async () => {
      const res = await patch({ shownLanguages: ["uk"], workers: { fake: 1 } });

      expect(res.json()).toMatchObject({ shownLanguages: ["uk"], services: [{ workers: 1 }] });
    });

    it("will not hide every language, and says why", async () => {
      const res = await patch({ shownLanguages: [] });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: "bad_request",
        message: "At least one language has to stay shown. Turn another one on first.",
      });
      expect(ctx.settings.shownLanguages()).toEqual(["en", "uk"]);
    });

    it.each([
      ["an unknown language", { shownLanguages: ["en", "de"] }],
      ["a repeated language", { shownLanguages: ["en", "en"] }],
      ["a string", { shownLanguages: "en" }],
      ["null", { shownLanguages: null }],
      ["numbers", { shownLanguages: [1] }],
    ])("rejects %s and changes nothing", async (_name, payload) => {
      const res = await patch(payload);

      expect(res.statusCode).toBe(400);
      expect(ctx.settings.shownLanguages()).toEqual(["en", "uk"]);
    });
  });
});
