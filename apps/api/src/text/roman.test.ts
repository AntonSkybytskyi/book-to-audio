import { describe, expect, it } from "vitest";
import { headingNumeral, isUnambiguousRoman, parseRoman, plainNumeral } from "./roman.js";

describe("parseRoman", () => {
  it.each([
    ["I", 1],
    ["IV", 4],
    ["IX", 9],
    ["XIX", 19],
    ["XX", 20],
    ["XLII", 42],
    ["XC", 90],
    ["MCMXCIX", 1999],
    ["MMXXIV", 2024],
    ["MMMCMXCIX", 3999],
  ])("reads %s as %i", (token, value) => {
    expect(parseRoman(token)).toBe(value);
  });

  it.each(["", "IIII", "VX", "IC", "XXXX", "MMMM", "iv", "ABC", "IIV", "VV"])(
    "rejects %s, which is not a numeral in its standard form",
    (token) => {
      expect(parseRoman(token)).toBeNull();
    },
  );

  it("reads the Cyrillic look-alikes only when asked", () => {
    expect(parseRoman("ХІХ")).toBeNull(); // Cyrillic Х and І
    expect(parseRoman("ХІХ", true)).toBe(19);
    expect(parseRoman("XІV", true)).toBe(14); // mixed
    expect(parseRoman("МСМ", true)).toBe(1900);
  });
});

describe("isUnambiguousRoman", () => {
  it("accepts longer numerals and the common one-letter ones", () => {
    expect(["II", "XIV", "I", "V", "X", "І", "Х"].every(isUnambiguousRoman)).toBe(true);
  });

  it("refuses single letters that are usually something else", () => {
    expect(["C", "D", "L", "M"].some(isUnambiguousRoman)).toBe(false);
  });
});

describe("headingNumeral", () => {
  it("reads the numerals of chapters", () => {
    expect(
      ["I", "V", "X", "II", "IV", "XIX", "XLII", "CXIX"].map((t) => headingNumeral(t)),
    ).toEqual([1, 5, 10, 2, 4, 19, 42, 119]);
  });

  it("never reads a label: single letters other than I V X, or anything with D or M", () => {
    for (const token of ["C", "D", "L", "M", "MIX", "CD", "DC", "MM", "CM", "XL1", "iv", "IIII"]) {
      expect([token, headingNumeral(token)]).toEqual([token, null]);
    }
    expect(headingNumeral("CLI")).toBeNull(); // 151
  });

  it("takes the Cyrillic look-alikes of I and X in Cyrillic text only", () => {
    expect(headingNumeral("ХІ")).toBeNull();
    expect(headingNumeral("ХІ", true)).toBe(11);
    expect(headingNumeral("С", true)).toBeNull();
  });
});

describe("plainNumeral", () => {
  it("reads two or more letters of I, V, X up to 39", () => {
    expect(["II", "IV", "XIX", "XXXIX"].map(plainNumeral)).toEqual([2, 4, 19, 39]);
  });

  it("leaves one letter, anything with L C D M, and larger numbers", () => {
    for (const token of ["I", "V", "X", "XL", "LI", "CD", "MIX", "XL", "XLV", "DC", "VIIII"]) {
      expect([token, plainNumeral(token)]).toEqual([token, null]);
    }
  });
});
