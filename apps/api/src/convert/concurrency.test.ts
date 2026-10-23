import { describe, expect, it } from "vitest";
import { ConcurrencyMeter } from "./concurrency.js";

const make = () => {
  let now = 0;
  return { meter: new ConcurrencyMeter(() => now), advance: (ms: number) => (now += ms) };
};

describe("ConcurrencyMeter", () => {
  it("is one for a worker that was alone the whole time", () => {
    const { meter, advance } = make();
    const reading = meter.enter();
    advance(10_000);

    expect(meter.averageSince(reading)).toBe(1);
  });

  it("weights the number of busy workers by how long it lasted", () => {
    const { meter, advance } = make();
    const mine = meter.enter();
    advance(4000); // alone for 4 s
    meter.enter();
    advance(6000); // two for 6 s

    expect(meter.averageSince(mine)).toBeCloseTo((4000 * 1 + 6000 * 2) / 10_000);
  });

  it("forgets what happened before the reading", () => {
    const { meter, advance } = make();
    meter.enter();
    meter.enter();
    meter.enter();
    advance(100_000);
    meter.leave();
    meter.leave();
    const mine = meter.enter(); // one other is still busy
    advance(5000);

    expect(meter.averageSince(mine)).toBe(2);
  });

  it("falls back to the current number when no time has passed", () => {
    const { meter } = make();
    meter.enter();
    const mine = meter.enter();

    expect(meter.averageSince(mine)).toBe(2);
  });

  it("never counts below zero", () => {
    const { meter, advance } = make();
    meter.leave();
    const mine = meter.enter();
    advance(1000);

    expect(meter.averageSince(mine)).toBe(1);
  });
});
