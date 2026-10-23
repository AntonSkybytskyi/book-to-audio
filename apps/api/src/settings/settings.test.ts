import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../testing/context.js";
import { SettingsStore } from "./settings.js";

describe("SettingsStore", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => ctx.cleanup());

  const store = () => new SettingsStore(ctx.db);

  describe("workers per service", () => {
    it("has no number of its own until the owner sets one", () => {
      expect(store().workersOverride("piper")).toBeUndefined();
    });

    it("saves a number per service, which survives a new store, and forgets it on null", () => {
      store().setWorkersOverride("piper", 5);
      store().setWorkersOverride("other", 2);

      expect(store().workersOverride("piper")).toBe(5);
      expect(store().workersOverride("other")).toBe(2);
      store().setWorkersOverride("piper", null);
      expect(store().workersOverride("piper")).toBeUndefined();
    });

    it("rejects values outside 1 to 64", () => {
      const settings = store();

      for (const value of [0, 65, -1, 1.5, Number.NaN]) {
        expect(() => settings.setWorkersOverride("piper", value)).toThrow(RangeError);
      }
      expect(settings.workersOverride("piper")).toBeUndefined();
    });
  });

  describe("shown languages", () => {
    it("are English and Ukrainian by default: Russian is supported but hidden", () => {
      expect(store().shownLanguages()).toEqual(["en", "uk"]);
    });

    it("are saved, in the order of the languages, and survive a new store", () => {
      store().setShownLanguages(["ru", "uk"]);

      expect(store().shownLanguages()).toEqual(["uk", "ru"]);
    });

    it("can all be shown, or just one", () => {
      const settings = store();

      settings.setShownLanguages(["en", "uk", "ru"]);
      expect(settings.shownLanguages()).toEqual(["en", "uk", "ru"]);
      settings.setShownLanguages(["ru"]);
      expect(settings.shownLanguages()).toEqual(["ru"]);
    });

    it("cannot be emptied or given an unknown language", () => {
      const settings = store();

      expect(() => settings.setShownLanguages([])).toThrow(RangeError);
      expect(() => settings.setShownLanguages(["en", "de"])).toThrow(RangeError);
      expect(settings.shownLanguages()).toEqual(["en", "uk"]);
    });

    it("fall back to the default when the saved value is damaged", () => {
      const settings = store();
      for (const value of ["not json", "[]", '["de"]', '"en"', "{}"]) {
        ctx.db
          .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('shown_languages', ?)")
          .run(value);

        expect(settings.shownLanguages()).toEqual(["en", "uk"]);
      }
    });

    it("keep the known ones when a saved list has others in it", () => {
      ctx.db
        .prepare("INSERT INTO settings (key, value) VALUES ('shown_languages', ?)")
        .run('["ru", "de", "en", "ru"]');

      expect(store().shownLanguages()).toEqual(["en", "ru"]);
    });
  });
});
