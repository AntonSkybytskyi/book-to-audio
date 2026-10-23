import { describe, expect, it } from "vitest";
import { prepareEnglish, spellYear } from "./english.js";

describe("spellYear", () => {
  it.each([
    [1999, "nineteen ninety-nine"],
    [1905, "nineteen oh five"],
    [1900, "nineteen hundred"],
    [1066, "ten sixty-six"],
    [1812, "eighteen twelve"],
    [1100, "eleven hundred"],
    [1010, "ten ten"],
  ])("says %i as %s", (year, words) => {
    expect(spellYear(year)).toBe(words);
  });

  it("leaves what the engine says well", () => {
    expect([1005, 2005, 2020, 999].map(spellYear)).toEqual([null, null, null, null]);
  });
});

describe("English years", () => {
  it.each([
    ["It happened in 1999.", "It happened in nineteen ninety-nine."],
    ["Since 1914 nothing was the same.", "Since nineteen fourteen nothing was the same."],
    ["He was born on June 3, 1887.", "He was born on June 3, eighteen eighty-seven."],
    ["The war began in 1066 AD.", "The war began in ten sixty-six AD."],
    ["The year 1805 was cold.", "The year eighteen oh five was cold."],
    ["Born (1812–1870), he wrote.", "Born (eighteen twelve to eighteen seventy), he wrote."],
  ])("%j", (text, expected) => {
    expect(prepareEnglish(text)).toBe(expected);
  });

  it("does not touch counts, prices and numbers with separators", () => {
    for (const text of [
      "He had 1,999 people.",
      "There were 1999 pages.",
      "It costs $1999.",
      "A total of 1500 men came.",
      "Room 1412 is upstairs.",
      "The ratio was 1.1999 to one.",
    ]) {
      expect(prepareEnglish(text)).toBe(text);
    }
  });

  it("reads decades", () => {
    expect(prepareEnglish("The 1990s and the 1800s and the 1920's.")).toBe(
      "The nineteen nineties and the eighteen hundreds and the nineteen twenties.",
    );
    expect(prepareEnglish("In the 1995s he waited.")).toBe("In the 1995s he waited.");
  });

  it("reads clear ranges of years", () => {
    expect(prepareEnglish("From 1914-1918 and 1939 – 1945.")).toBe(
      "From nineteen fourteen to nineteen eighteen and nineteen thirty-nine to nineteen forty-five.",
    );
    expect(prepareEnglish("From 1914 to 1918, between 1939 and 1945.")).toBe(
      "From nineteen fourteen to nineteen eighteen, between nineteen thirty-nine and nineteen forty-five.",
    );
    expect(prepareEnglish("He bought 1200 and 1500 shares.")).toBe(
      "He bought 1200 and 1500 shares.",
    );
  });
});

describe("English Roman numerals", () => {
  it.each([
    ["Chapter IV", "Chapter 4"],
    ["See Part II and Book XII.", "See Part 2 and Book 12."],
    ["World War II ended.", "World War 2 ended."],
    ["Act I, Scene II.", "Act 1, Scene 2."],
    ["Henry VIII had six wives.", "Henry the 8th had six wives."],
    ["Elizabeth II was crowned.", "Elizabeth the 2nd was crowned."],
    ["Louis XIV's court.", "Louis the 14th's court."],
    ["Pope John Paul II spoke.", "Pope John Paul the 2nd spoke."],
    ["Chapter iv", "Chapter iv"],
    ["Chapter IIII", "Chapter IIII"],
  ])("%j", (text, expected) => {
    expect(prepareEnglish(text)).toBe(expected);
  });

  it("reads a paragraph that is only a numeral as a number", () => {
    expect(prepareEnglish("IV")).toBe("4");
    expect(prepareEnglish("XII.")).toBe("12.");
    expect(prepareEnglish("C")).toBe("C");
  });

  it("leaves the pronoun and other words alone", () => {
    for (const text of [
      "John I think so.",
      "Then I said that Vitamin C helps.",
      "They act I suppose.",
      "Malcolm X spoke.",
      "I went home.",
      "Chapter and verse.",
    ]) {
      expect(prepareEnglish(text)).toBe(text);
    }
    expect(prepareEnglish("Elizabeth I.")).toBe("Elizabeth the 1st.");
  });
});

describe("English abbreviations", () => {
  it.each([
    ["Martin Luther King Jr. spoke.", "Martin Luther King Junior spoke."],
    ["Acme Inc. He left.", "Acme Incorporated. He left."],
    ["Mt. Everest and Lt. Smith.", "Mount Everest and Lieutenant Smith."],
    [
      "Col. Mustard, Sgt. Pepper and Capt. Ahab.",
      "Colonel Mustard, Sergeant Pepper and Captain Ahab.",
    ],
    ["Dr. Jones vs. Smith.", "Dr. Jones versus Smith."],
    ["See ch. 3, pp. 12-15 and fig. 2.", "See chapter 3, pages 12-15 and figure 2."],
    ["It was 5 ft. tall.", "It was 5 feet tall."],
    ["Rev. Smith and Prof. Higgins.", "Reverend Smith and Professor Higgins."],
    ["She earned a Ph.D. in 1990.", "She earned a P H D in nineteen ninety."],
    ["On Fifth Ave. there.", "On Fifth Avenue there."],
  ])("%j", (text, expected) => {
    expect(prepareEnglish(text)).toBe(expected);
  });

  it("only expands where the context fits", () => {
    for (const text of [
      "The ch. was long.", // no number after it
      "He said mt. is a unit.", // lower case
      "Gen. ", // nothing follows
      "Mr. Smith and Mrs. Jones.", // read well by the engine
      "St. Paul and No. 5.",
      "The jr. staff.", // not after a name
    ]) {
      expect(prepareEnglish(text)).toBe(text);
    }
  });
});
