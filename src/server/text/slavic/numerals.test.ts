import { describe, expect, it } from "vitest";
import { numeralsRu } from "./numerals-ru.js";
import { numeralsUk } from "./numerals-uk.js";

describe("Ukrainian numerals", () => {
  it.each([
    [0, "нуль"],
    [1, "один"],
    [5, "п'ять"],
    [11, "одинадцять"],
    [21, "двадцять один"],
    [100, "сто"],
    [101, "сто один"],
    [999, "дев'ятсот дев'яносто дев'ять"],
    [1000, "тисяча"],
    [1999, "тисяча дев'ятсот дев'яносто дев'ять"],
    [2000, "дві тисячі"],
    [2005, "дві тисячі п'ять"],
    [5000, "п'ять тисяч"],
    [21000, "двадцять одна тисяча"],
    [22000, "двадцять дві тисячі"],
    [100000, "сто тисяч"],
    [1000000, "один мільйон"],
    [2500000, "два мільйони п'ятсот тисяч"],
    [1000000000, "один мільярд"],
  ])("spells %i as %s", (n, words) => {
    expect(numeralsUk.cardinal(n)).toBe(words);
  });

  it("agrees 1 and 2 with the gender", () => {
    expect(numeralsUk.cardinal(1, "f")).toBe("одна");
    expect(numeralsUk.cardinal(1, "n")).toBe("одне");
    expect(numeralsUk.cardinal(2, "f")).toBe("дві");
    expect(numeralsUk.cardinal(22, "f")).toBe("двадцять дві");
    expect(numeralsUk.cardinal(12, "f")).toBe("дванадцять");
  });

  it("refuses what it cannot spell", () => {
    expect(() => numeralsUk.cardinal(-1)).toThrow(RangeError);
    expect(() => numeralsUk.cardinal(1.5)).toThrow(RangeError);
    expect(() => numeralsUk.cardinal(10 ** 12)).toThrow(RangeError);
  });

  it.each([
    [1, "m", "nom", "перший"],
    [3, "m", "nom", "третій"],
    [3, "m", "gen", "третього"],
    [3, "n", "loc", "третьому"],
    [3, "f", "gen", "третьої"],
    [20, "m", "nom", "двадцятий"],
    [21, "n", "gen", "двадцять першого"],
    [19, "n", "nom", "дев'ятнадцяте"],
    [40, "m", "nom", "сороковий"],
    [100, "m", "nom", "сотий"],
    [200, "m", "gen", "двохсотого"],
    [1999, "m", "loc", "тисяча дев'ятсот дев'яносто дев'ятому"],
    [1814, "m", "gen", "тисяча вісімсот чотирнадцятого"],
    [1900, "m", "nom", "тисяча дев'ятисотий"],
    [1000, "m", "nom", "тисячний"],
    [2000, "m", "nom", "двотисячний"],
    [2005, "m", "loc", "дві тисячі п'ятому"],
    [2020, "m", "gen", "дві тисячі двадцятого"],
    [4, "f", "nom", "четверта"],
    [4, "f", "acc", "четверту"],
    [4, "f", "ins", "четвертою"],
    [7, "n", "nom", "сьоме"],
  ] as const)("declines the ordinal %i (%s, %s) as %s", (n, gender, grammaticalCase, words) => {
    expect(numeralsUk.ordinal(n, gender, grammaticalCase)).toBe(words);
  });

  it("has no ordinal outside 1 to 2999", () => {
    expect(numeralsUk.ordinal(0, "m", "nom")).toBeNull();
    expect(numeralsUk.ordinal(3000, "m", "nom")).toBeNull();
  });

  it("picks the form of the noun after a number", () => {
    const forms = ["рік", "роки", "років"] as const;
    expect([1, 2, 5, 11, 12, 21, 22, 25, 101, 111].map((n) => numeralsUk.plural(n, forms))).toEqual(
      ["рік", "роки", "років", "років", "років", "рік", "роки", "років", "рік", "років"],
    );
  });
});

describe("Russian numerals", () => {
  it.each([
    [1, "один"],
    [4, "четыре"],
    [21, "двадцать один"],
    [1999, "тысяча девятьсот девяносто девять"],
    [2000, "две тысячи"],
    [3000, "три тысячи"],
    [21000, "двадцать одна тысяча"],
    [1000000, "один миллион"],
    [2000000, "два миллиона"],
    [5000000, "пять миллионов"],
  ])("spells %i as %s", (n, words) => {
    expect(numeralsRu.cardinal(n)).toBe(words);
  });

  it("agrees 1 and 2 with the gender", () => {
    expect(numeralsRu.cardinal(1, "n")).toBe("одно");
    expect(numeralsRu.cardinal(1, "f")).toBe("одна");
    expect(numeralsRu.cardinal(2, "f")).toBe("две");
  });

  it.each([
    [1, "m", "nom", "первый"],
    [2, "m", "nom", "второй"],
    [2, "f", "gen", "второй"],
    [2, "n", "gen", "второго"],
    [3, "m", "nom", "третий"],
    [3, "n", "gen", "третьего"],
    [3, "f", "acc", "третью"],
    [3, "m", "loc", "третьем"],
    [4, "f", "nom", "четвёртая"],
    [7, "m", "ins", "седьмым"],
    [40, "m", "nom", "сороковой"],
    [21, "n", "gen", "двадцать первого"],
    [200, "m", "nom", "двухсотый"],
    [1999, "m", "loc", "тысяча девятьсот девяносто девятом"],
    [1812, "m", "loc", "тысяча восемьсот двенадцатом"],
    [1900, "m", "gen", "тысяча девятисотого"],
    [2000, "m", "nom", "двухтысячный"],
    [2005, "m", "loc", "две тысячи пятом"],
    [2024, "m", "gen", "две тысячи двадцать четвёртого"],
    [19, "m", "loc", "девятнадцатом"],
  ] as const)("declines the ordinal %i (%s, %s) as %s", (n, gender, grammaticalCase, words) => {
    expect(numeralsRu.ordinal(n, gender, grammaticalCase)).toBe(words);
  });

  it("picks the form of the noun after a number", () => {
    const forms = ["процент", "процента", "процентов"] as const;
    expect([1, 3, 5, 14, 21, 100].map((n) => numeralsRu.plural(n, forms))).toEqual([
      "процент",
      "процента",
      "процентов",
      "процентов",
      "процент",
      "процентов",
    ]);
  });
});

describe("plural ordinals and decades", () => {
  it.each([
    [90, "nom", "дев'яності"],
    [90, "gen", "дев'яностих"],
    [90, "ins", "дев'яностими"],
    [1990, "gen", "дев'яностих"],
    [1900, "nom", "тисяча дев'ятисоті"],
    [2000, "gen", "двотисячних"],
    [2010, "nom", "дві тисячі десяті"],
    [20, "nom", "двадцяті"],
  ] as const)("Ukrainian decade %i (%s) is %s", (n, grammaticalCase, words) => {
    expect(numeralsUk.decade(n, grammaticalCase)).toBe(words);
  });

  it.each([
    [90, "nom", "девяностые"],
    [1990, "gen", "девяностых"],
    [2000, "nom", "двухтысячные"],
    [20, "ins", "двадцатыми"],
    [10, "nom", "десятые"],
  ] as const)("Russian decade %i (%s) is %s", (n, grammaticalCase, words) => {
    expect(numeralsRu.decade(n, grammaticalCase)).toBe(words);
  });

  it("has no decade for a number that is not one", () => {
    expect(numeralsRu.decade(1995, "nom")).toBeNull();
    expect(numeralsUk.decade(5, "nom")).toBeNull();
  });

  it("declines the third in the plural with the soft endings", () => {
    expect(numeralsUk.ordinal(3, "p", "nom")).toBe("треті");
    expect(numeralsUk.ordinal(3, "p", "gen")).toBe("третіх");
    expect(numeralsRu.ordinal(3, "p", "nom")).toBe("третьи");
    expect(numeralsRu.ordinal(3, "p", "gen")).toBe("третьих");
    expect(numeralsRu.ordinal(2, "p", "nom")).toBe("вторые");
  });
});

describe("Ukrainian cardinals in the genitive", () => {
  it.each([
    [1, "m", "одного"],
    [1, "f", "однієї"],
    [2, "m", "двох"],
    [5, "m", "п'яти"],
    [11, "m", "одинадцяти"],
    [21, "m", "двадцяти одного"],
    [40, "m", "сорока"],
    [90, "m", "дев'яноста"],
    [100, "m", "ста"],
    [200, "m", "двохсот"],
    [1000, "m", "тисячі"],
    [2000, "m", "двох тисяч"],
    [21000, "m", "двадцяти однієї тисячі"],
    [1000000, "m", "одного мільйона"],
    [5000000, "m", "п'яти мільйонів"],
    [0, "m", "нуля"],
  ] as const)("%i (%s) is %s", (n, gender, words) => {
    expect(numeralsUk.cardinalGenitive?.(n, gender)).toBe(words);
  });

  it("is not offered for Russian, whose digits are left to the engine", () => {
    expect(numeralsRu.cardinalGenitive).toBeUndefined();
  });
});
