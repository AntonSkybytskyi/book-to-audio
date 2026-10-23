import { describe, expect, it } from "vitest";
import { parseRange } from "./range.js";

describe("parseRange", () => {
  it.each([
    ["bytes=0-99", 1000, { start: 0, end: 99 }],
    ["bytes=500-", 1000, { start: 500, end: 999 }],
    ["bytes=-100", 1000, { start: 900, end: 999 }],
    ["bytes=-5000", 1000, { start: 0, end: 999 }],
    ["bytes=900-5000", 1000, { start: 900, end: 999 }],
    ["bytes=0-0", 1000, { start: 0, end: 0 }],
  ])("parses %s of %i bytes", (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });

  it.each([
    ["bytes=1000-", 1000],
    ["bytes=2000-3000", 1000],
    ["bytes=-0", 1000],
    ["bytes=0-10", 0],
  ])("rejects %s of %i bytes as unsatisfiable", (header, size) => {
    expect(parseRange(header, size)).toBe("unsatisfiable");
  });

  it.each([undefined, "", "items=0-5", "bytes=0-5,10-20", "bytes=-", "bytes=9-3", "garbage"])(
    "ignores %j",
    (header) => {
      expect(parseRange(header, 1000)).toBeNull();
    },
  );
});
