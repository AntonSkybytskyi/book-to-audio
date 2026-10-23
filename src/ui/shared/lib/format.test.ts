import { describe, expect, it } from "vitest";
import {
  aboutDuration,
  formatApprox,
  formatBytes,
  formatClock,
  formatMinutes,
  formatWords,
  pluralize,
} from "./format";

describe("formatClock", () => {
  it.each([
    [0, "0:00"],
    [5, "0:05"],
    [75, "1:15"],
    [3599.6, "1:00:00"],
    [3725, "1:02:05"],
    [-3, "0:00"],
  ])("formats %d seconds as %s", (seconds, expected) => {
    expect(formatClock(seconds)).toBe(expected);
  });
});

describe("formatMinutes", () => {
  it.each([
    [1, "1 min"],
    [59, "59 min"],
    [60, "1 h"],
    [125, "2 h 5 min"],
  ])("formats %d minutes as %s", (minutes, expected) => {
    expect(formatMinutes(minutes)).toBe(expected);
  });
});

describe("formatApprox", () => {
  it.each([
    [0, "under a minute"],
    [59, "under a minute"],
    [60, "1 min"],
    [89, "1 min"],
    [91, "2 min"],
    [7 * 60 + 20, "7 min"],
    [9 * 60 + 40, "10 min"],
    [12 * 60, "10 min"],
    [13 * 60, "15 min"],
    [47 * 60, "45 min"],
    [58 * 60, "1 h"],
    [3600 + 2 * 60, "1 h"],
    [2 * 3600 + 13 * 60, "2 h 15 min"],
    [9 * 3600 + 58 * 60, "10 h"],
    [10 * 3600 + 22 * 60, "10 h 20 min"],
    [26 * 3600 + 7 * 60, "26 h 10 min"],
  ])("says %d seconds as %s, without more precision than there is", (seconds, expected) => {
    expect(formatApprox(seconds)).toBe(expected);
  });

  it("never rounds a time of a minute or more down to nothing", () => {
    for (let seconds = 60; seconds < 400; seconds += 7) {
      expect(formatApprox(seconds)).not.toBe("0 min");
    }
  });

  it("only goes up as the time grows, so a countdown never jumps back", () => {
    let last = 0;
    for (let seconds = 0; seconds < 40 * 3600; seconds += 37) {
      const text = formatApprox(seconds);
      const hours = Number(/(\d+) h/.exec(text)?.[1] ?? 0);
      const rest = Number(/(\d+) min/.exec(text)?.[1] ?? 0);
      const minutes = text === "under a minute" ? 0 : hours * 60 + rest;
      expect(minutes).toBeGreaterThanOrEqual(last);
      last = minutes;
    }
  });
});

describe("aboutDuration", () => {
  it("puts about in front of a figure, and nothing before under a minute", () => {
    expect(aboutDuration(8100)).toBe("about 2 h 15 min");
    expect(aboutDuration(30)).toBe("under a minute");
    expect(aboutDuration(300)).toBe("about 5 min");
  });
});

describe("text helpers", () => {
  it("formats word counts", () => {
    expect(formatWords(1)).toBe("1 word");
    expect(formatWords(12345)).toBe("12,345 words");
  });

  it("pluralizes", () => {
    expect(pluralize(1, "chapter")).toBe("1 chapter");
    expect(pluralize(3, "chapter")).toBe("3 chapters");
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "1 KB"],
    [900, "1 KB"],
    [512 * 1024, "512 KB"],
    [1024 * 1024 * 3.26, "3.3 MB"],
    [74.4 * 1024 * 1024, "74 MB"],
    [1000 * 1024 * 1024, "1.0 GB"],
    [12.6 * 1024 ** 3, "13 GB"],
  ])("formats %d bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
