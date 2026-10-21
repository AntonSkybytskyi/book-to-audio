import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../testing/context.js";
import { FAILURE_LIMIT, PoolStateStore } from "./pool-state.js";

describe("PoolStateStore", () => {
  let ctx: TestContext;
  let store: PoolStateStore;

  beforeEach(() => {
    ctx = createTestContext();
    store = new PoolStateStore(ctx.db);
  });

  afterEach(() => ctx.cleanup());

  it("starts running with no failures", () => {
    expect(store.get()).toEqual({
      state: "running",
      error: null,
      cause: null,
      consecutiveFailures: 0,
    });
  });

  it("trips on the third failure in a row and keeps the message", () => {
    expect(store.recordFailure("one")).toBe(false);
    expect(store.recordFailure("two")).toBe(false);
    expect(store.get().state).toBe("running");

    expect(store.recordFailure("three")).toBe(true);

    expect(FAILURE_LIMIT).toBe(3);
    expect(store.get()).toEqual({
      state: "paused",
      error: "three",
      cause: "failures",
      consecutiveFailures: 3,
    });
  });

  it("is reset by any success", () => {
    store.recordFailure("one");
    store.recordFailure("two");

    store.recordSuccess();

    expect(store.recordFailure("three")).toBe(false);
    expect(store.get()).toMatchObject({ state: "running", consecutiveFailures: 1 });
  });

  it("keeps the first error when more chapters fail after the pause", () => {
    for (const message of ["a", "b", "c"]) store.recordFailure(message);

    expect(store.recordFailure("late")).toBe(false);

    expect(store.get()).toMatchObject({ state: "paused", error: "c" });
  });

  it("resumes once and clears the error and the count", () => {
    for (const message of ["a", "b", "c"]) store.recordFailure(message);

    expect(store.resume()).toBe(true);
    expect(store.resume()).toBe(false);

    expect(store.get()).toEqual({
      state: "running",
      error: null,
      cause: null,
      consecutiveFailures: 0,
    });
    expect(store.recordFailure("again")).toBe(false); // the count starts from zero
  });

  it("pauses for a reason of its own, once, and says why", () => {
    expect(store.pause("disk", "The disk is almost full.")).toBe(true);
    expect(store.pause("disk", "again")).toBe(false);

    expect(store.get()).toEqual({
      state: "paused",
      error: "The disk is almost full.",
      cause: "disk",
      consecutiveFailures: 0,
    });
    expect(store.resume()).toBe(true);
    expect(store.get()).toMatchObject({ state: "running", error: null, cause: null });
  });

  it("does not let a failure that comes after a disk pause change the reason", () => {
    store.pause("disk", "The disk is almost full.");
    for (const message of ["a", "b", "c"]) store.recordFailure(message);

    expect(store.get()).toMatchObject({ cause: "disk", error: "The disk is almost full." });
  });

  it("survives a restart: a second store on the same database sees the pause", () => {
    for (const message of ["a", "b", "c"]) store.recordFailure(message);

    expect(new PoolStateStore(ctx.db).get()).toMatchObject({ state: "paused", error: "c" });
  });
});
