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

  it("starts running, every service with no failures", () => {
    expect(store.get()).toEqual({ state: "running", error: null, cause: null });
    expect(store.service("piper")).toEqual({
      state: "running",
      error: null,
      consecutiveFailures: 0,
    });
  });

  it("pauses a service on its third failure in a row and keeps the message", () => {
    expect(store.recordFailure("piper", "one")).toBe(false);
    expect(store.recordFailure("piper", "two")).toBe(false);
    expect(store.service("piper").state).toBe("running");

    expect(store.recordFailure("piper", "three")).toBe(true);

    expect(FAILURE_LIMIT).toBe(3);
    expect(store.service("piper")).toEqual({
      state: "paused",
      error: "three",
      consecutiveFailures: 3,
    });
    expect(store.get().state).toBe("running"); // the pool and other services carry on
    expect(store.service("other").state).toBe("running");
  });

  it("counts each service on its own", () => {
    store.recordFailure("piper", "one");
    store.recordFailure("other", "two");

    expect(store.recordFailure("piper", "three")).toBe(false);
    expect(store.service("piper").consecutiveFailures).toBe(2);
    expect(store.service("other").consecutiveFailures).toBe(1);
  });

  it("is reset by any success of the service", () => {
    store.recordFailure("piper", "one");
    store.recordFailure("piper", "two");

    store.recordSuccess("piper");

    expect(store.recordFailure("piper", "three")).toBe(false);
    expect(store.service("piper")).toMatchObject({ state: "running", consecutiveFailures: 1 });
  });

  it("keeps the first error when more chapters fail after the pause", () => {
    for (const message of ["a", "b", "c"]) store.recordFailure("piper", message);

    expect(store.recordFailure("piper", "late")).toBe(false);

    expect(store.service("piper")).toMatchObject({ state: "paused", error: "c" });
  });

  it("resumes one service once and clears its error and count", () => {
    for (const message of ["a", "b", "c"]) store.recordFailure("piper", message);
    for (const message of ["a", "b", "c"]) store.recordFailure("other", message);

    expect(store.resume("piper")).toBe(true);
    expect(store.resume("piper")).toBe(false);

    expect(store.service("piper")).toEqual({
      state: "running",
      error: null,
      consecutiveFailures: 0,
    });
    expect(store.service("other").state).toBe("paused");
    expect(store.recordFailure("piper", "again")).toBe(false); // the count starts from zero
  });

  it("pauses the pool for a reason of its own, once, says why, and resumes everything", () => {
    for (const message of ["a", "b", "c"]) store.recordFailure("piper", message);
    expect(store.pause("disk", "The disk is almost full.")).toBe(true);
    expect(store.pause("disk", "again")).toBe(false);

    expect(store.get()).toEqual({
      state: "paused",
      error: "The disk is almost full.",
      cause: "disk",
    });
    expect(store.resume()).toBe(true);
    expect(store.get()).toEqual({ state: "running", error: null, cause: null });
    expect(store.service("piper").state).toBe("running");
  });

  it("leaves the disk pause alone when only a service is resumed", () => {
    store.pause("disk", "The disk is almost full.");

    expect(store.resume("piper")).toBe(false);

    expect(store.get().state).toBe("paused");
  });

  it("survives a restart: a second store on the same database sees the pause", () => {
    for (const message of ["a", "b", "c"]) store.recordFailure("piper", message);

    expect(new PoolStateStore(ctx.db).service("piper")).toMatchObject({
      state: "paused",
      error: "c",
    });
  });
});
