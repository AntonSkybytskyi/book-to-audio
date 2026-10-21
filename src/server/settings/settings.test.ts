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
    expect(store(12).view()).toEqual({ workers: 6, maxWorkers: 12, defaultWorkers: 6 });
    expect(store(7).workers()).toBe(3);
    expect(store(1).workers()).toBe(1);
  });

  it("uses WORKERS as the default, but never more than the cores", () => {
    expect(store(8, 3).view()).toEqual({ workers: 3, maxWorkers: 8, defaultWorkers: 3 });
    expect(store(4, 64).view()).toEqual({ workers: 4, maxWorkers: 4, defaultWorkers: 4 });
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
});
