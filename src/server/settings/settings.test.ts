import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../testing/context.js";
import { SettingsStore } from "./settings.js";

describe("SettingsStore", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => ctx.cleanup());

  const store = (cpus: number, envWorkers?: number) =>
    new SettingsStore(ctx.db, { cpus, envWorkers });

  it("defaults to half the cores, at least one", () => {
    expect(store(12).view()).toMatchObject({ workers: 6, maxWorkers: 12, defaultWorkers: 6 });
    expect(store(7).workers()).toBe(3);
    expect(store(1).workers()).toBe(1);
  });

  it("uses WORKERS as the default, but never more than the cores", () => {
    expect(store(8, 3).view()).toMatchObject({ workers: 3, maxWorkers: 8, defaultWorkers: 3 });
    expect(store(4, 64).view()).toMatchObject({ workers: 4, maxWorkers: 4, defaultWorkers: 4 });
  });

  it("saves a choice, which wins over the default and survives a new store", () => {
    store(8, 2).setWorkers(5);

    expect(store(8, 2).workers()).toBe(5);
  });

  it("rejects values outside 1 to the maximum", () => {
    const settings = store(4);

    for (const value of [0, 5, -1, 1.5, Number.NaN]) {
      expect(() => settings.setWorkers(value)).toThrow(RangeError);
    }
    expect(settings.workers()).toBe(2);
  });

  it("brings a saved value back into range when the machine has fewer cores", () => {
    store(16).setWorkers(12);

    expect(store(4).workers()).toBe(4);
  });

  describe("shown languages", () => {
    it("are English and Ukrainian by default: Russian is supported but hidden", () => {
      expect(store(4).shownLanguages()).toEqual(["en", "uk"]);
      expect(store(4).view().shownLanguages).toEqual(["en", "uk"]);
    });

    it("are saved, in the order of the languages, and survive a new store", () => {
      store(4).setShownLanguages(["ru", "uk"]);

      expect(store(4).shownLanguages()).toEqual(["uk", "ru"]);
    });

    it("can all be shown, or just one", () => {
      const settings = store(4);

      settings.setShownLanguages(["en", "uk", "ru"]);
      expect(settings.shownLanguages()).toEqual(["en", "uk", "ru"]);
      settings.setShownLanguages(["ru"]);
      expect(settings.shownLanguages()).toEqual(["ru"]);
    });

    it("cannot be emptied or given an unknown language", () => {
      const settings = store(4);

      expect(() => settings.setShownLanguages([])).toThrow(RangeError);
      expect(() => settings.setShownLanguages(["en", "de"])).toThrow(RangeError);
      expect(settings.shownLanguages()).toEqual(["en", "uk"]);
    });

    it("fall back to the default when the saved value is damaged", () => {
      const settings = store(4);
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

      expect(store(4).shownLanguages()).toEqual(["en", "ru"]);
    });
  });
});
