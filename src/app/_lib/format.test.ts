import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatClock,
  formatMinutes,
  formatWords,
  languageName,
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

describe("text helpers", () => {
  it("formats word counts", () => {
    expect(formatWords(1)).toBe("1 word");
    expect(formatWords(12345)).toBe("12,345 words");
  });

  it("pluralizes", () => {
    expect(pluralize(1, "chapter")).toBe("1 chapter");
    expect(pluralize(3, "chapter")).toBe("3 chapters");
  });

  it("names languages and passes unknown codes through", () => {
    expect(languageName("uk")).toBe("Ukrainian");
    expect(languageName("de")).toBe("de");
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
