import { describe, expect, it } from "vitest";
import type { PoolStatus, ServicePoolStatus } from "./api";
import { pauseFor, servicePool } from "./pool";

const service = (id: string, overrides: Partial<ServicePoolStatus> = {}): ServicePoolStatus => ({
  id,
  state: "running",
  error: null,
  reachable: true,
  workers: 2,
  reportedWorkers: 2,
  activeWorkers: 0,
  ...overrides,
});

const pool = (overrides: Partial<PoolStatus> = {}): PoolStatus => ({
  state: "running",
  error: null,
  cause: null,
  workers: 3,
  activeWorkers: 0,
  held: false,
  services: [service("piper"), service("other", { workers: 1, state: "paused" })],
  ...overrides,
});

describe("the pool of a speech service", () => {
  it("is found by name", () => {
    expect(servicePool(pool(), "other")?.workers).toBe(1);
    expect(servicePool(pool(), "nope")).toBeUndefined();
    expect(servicePool(null, "piper")).toBeUndefined();
  });

  it("holds a book up when all conversion is paused, or its own service is", () => {
    expect(pauseFor(pool(), "piper")).toBeNull();
    expect(pauseFor(pool(), "other")).toBe("service");
    expect(pauseFor(pool({ state: "paused" }), "piper")).toBe("all");
    expect(pauseFor(pool(), undefined)).toBeNull();
    expect(pauseFor(null, "piper")).toBeNull();
  });
});
