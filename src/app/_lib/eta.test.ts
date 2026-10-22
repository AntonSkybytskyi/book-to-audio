import { describe, expect, it } from "vitest";
import { formatLeft, secondsLeft } from "./eta";

const at = (seconds: number, progress: number) => ({ at: seconds * 1000, progress });

describe("secondsLeft", () => {
  it("extends the speed so far to the end", () => {
    // 20% in 40 s: 80% more takes 160 s.
    expect(secondsLeft(at(0, 0), at(40, 0.2))).toBeCloseTo(160);
    // Started at 10%, so only the movement counts.
    expect(secondsLeft(at(0, 0.1), at(60, 0.4))).toBeCloseTo(120);
  });

  it("says nothing for the first seconds, the first few percent, no movement, or a build that is over", () => {
    expect(secondsLeft(at(0, 0), at(3, 0.5))).toBeNull();
    expect(secondsLeft(at(0, 0), at(60, 0.02))).toBeNull();
    expect(secondsLeft(at(0, 0.3), at(60, 0.3))).toBeNull();
    expect(secondsLeft(at(0, 0), at(60, 1))).toBeNull();
  });
});

describe("formatLeft", () => {
  it.each([
    [10, "less than a minute left"],
    [59, "less than a minute left"],
    [60, "about 1 min left"],
    [200, "about 3 min left"],
    [3900, "about 1 h 5 min left"],
  ])("formats %d seconds as %s", (seconds, expected) => {
    expect(formatLeft(seconds)).toBe(expected);
  });
});
