import { describe, expect, it, vi } from "vitest";
import { PoolGate } from "./pool-gate.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const make = () => {
  const changes = vi.fn<() => void>();
  return { gate: new PoolGate(changes), changes };
};

describe("PoolGate", () => {
  describe("hold", () => {
    it("holds at once, so nothing new starts while the running chapters finish", async () => {
      const { gate, changes } = make();
      const running = deferred();

      const held = gate.hold(() => [running.promise]);

      expect(gate.held).toBe(true);
      expect(changes).toHaveBeenCalledTimes(1);
      let done = false;
      void held.then(() => (done = true));
      await Promise.resolve();
      expect(done).toBe(false);
      running.resolve();
      const release = await held;
      expect(done).toBe(true);
      release();
      expect(gate.held).toBe(false);
      expect(changes).toHaveBeenCalledTimes(2);
    });

    it("does not mind a chapter that ends badly", async () => {
      const { gate } = make();

      const release = await gate.hold(() => [Promise.reject(new Error("failed"))]);

      expect(gate.held).toBe(true);
      release();
    });

    it("lifts the hold when the wait is cancelled", async () => {
      const { gate } = make();
      const controller = new AbortController();

      const held = gate.hold(() => [new Promise<void>(() => {})], controller.signal);
      expect(gate.held).toBe(true);
      controller.abort(new Error("cancelled"));

      await expect(held).rejects.toThrow("cancelled");
      expect(gate.held).toBe(false);
    });

    it("lifts the hold when it was cancelled before it started", async () => {
      const { gate } = make();
      const controller = new AbortController();
      controller.abort();

      await expect(gate.hold(() => [], controller.signal)).rejects.toBeInstanceOf(Error);
      expect(gate.held).toBe(false);
    });

    it("lets go only once, however often the release is called", async () => {
      const { gate, changes } = make();
      const release = await gate.hold(() => []);

      release();
      release();

      expect(gate.held).toBe(false);
      expect(changes).toHaveBeenCalledTimes(2);
    });

    it("stays held until every hold is released", async () => {
      const { gate } = make();
      const first = await gate.hold(() => []);
      const second = await gate.hold(() => []);

      first();
      expect(gate.held).toBe(true);
      second();
      expect(gate.held).toBe(false);
    });
  });

  describe("holdWhenIdle", () => {
    it("holds at once when the pool is idle", async () => {
      const { gate } = make();

      const release = await gate.holdWhenIdle(() => true);

      expect(gate.held).toBe(true);
      release();
    });

    it("waits while the pool is busy, without holding it, so conversions are not delayed", async () => {
      const { gate } = make();
      let idle = false;

      const waiting = gate.holdWhenIdle(() => idle);

      expect(gate.held).toBe(false);
      gate.offerIdle(() => idle);
      expect(gate.held).toBe(false);
      idle = true;
      gate.offerIdle(() => idle);
      const release = await waiting;
      expect(gate.held).toBe(true);
      release();
    });

    it("does not give the hold to a waiter while the pool is held by someone else", async () => {
      const { gate } = make();
      const other = await gate.hold(() => []);
      const waiting = gate.holdWhenIdle(() => true);
      let done = false;
      void waiting.then(() => (done = true));

      gate.offerIdle(() => true);
      await Promise.resolve();

      expect(done).toBe(false);
      other();
      gate.offerIdle(() => true);
      (await waiting)();
    });

    it("stops waiting when cancelled", async () => {
      const { gate } = make();
      const controller = new AbortController();
      const waiting = gate.holdWhenIdle(() => false, controller.signal);

      controller.abort(new Error("cancelled"));

      await expect(waiting).rejects.toThrow("cancelled");
      gate.offerIdle(() => true);
      expect(gate.held).toBe(false); // nobody is left to give it to
    });

    it("rejects at once when already cancelled", async () => {
      const { gate } = make();
      const controller = new AbortController();
      controller.abort();

      await expect(gate.holdWhenIdle(() => true, controller.signal)).rejects.toBeInstanceOf(Error);
      expect(gate.held).toBe(false);
    });
  });
});
