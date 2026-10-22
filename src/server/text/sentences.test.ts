import { describe, expect, it } from "vitest";
import { splitSentences } from "./sentences.js";

describe("splitSentences", () => {
  it("splits on sentence punctuation", () => {
    expect(splitSentences("Hello there. How are you? Fine!", "en")).toEqual([
      "Hello there.",
      "How are you?",
      "Fine!",
    ]);
  });

  it("works for Ukrainian and Russian", () => {
    expect(splitSentences("Привіт, світе. Як справи?", "uk")).toEqual([
      "Привіт, світе.",
      "Як справи?",
    ]);
    expect(splitSentences("Привет, мир. Как дела?", "ru")).toEqual(["Привет, мир.", "Как дела?"]);
  });

  it("returns nothing for blank text and one piece for text without a stop", () => {
    expect(splitSentences("  ", "en")).toEqual([]);
    expect(splitSentences("no stop here", "en")).toEqual(["no stop here"]);
  });

  describe("English", () => {
    it.each([
      [
        "Mr. Smith met Dr. Jones in St. Paul. They talked.",
        ["Mr. Smith met Dr. Jones in St. Paul.", "They talked."],
      ],
      [
        "Mrs. Dalloway said she would buy the flowers herself.",
        ["Mrs. Dalloway said she would buy the flowers herself."],
      ],
      [
        "He studied cats, dogs, e.g. spaniels, etc. and left.",
        ["He studied cats, dogs, e.g. spaniels, etc. and left."],
      ],
      ["This, i.e. that one. Next.", ["This, i.e. that one.", "Next."]],
      [
        "Prof. Higgins vs. Col. Pickering. Who won?",
        ["Prof. Higgins vs. Col. Pickering.", "Who won?"],
      ],
      [
        "See No. 5 and Fig. 2. Then Vol. 3, p. 12 follows.",
        ["See No. 5 and Fig. 2.", "Then Vol. 3, p. 12 follows."],
      ],
    ])("does not break inside %j", (text, expected) => {
      expect(splitSentences(text, "en")).toEqual(expected);
    });

    it("keeps initials with the name", () => {
      expect(splitSentences("J. R. R. Tolkien wrote it. Then C. S. Lewis read it.", "en")).toEqual([
        "J. R. R. Tolkien wrote it.",
        "Then C. S. Lewis read it.",
      ]);
    });

    it("ends the sentence at an abbreviation that can end it, when a capital follows", () => {
      expect(splitSentences("He bought pens, paper, etc. Then he left.", "en")).toEqual([
        "He bought pens, paper, etc.",
        "Then he left.",
      ]);
      expect(splitSentences("It was 5 p.m. Then it rained.", "en")).toEqual([
        "It was 5 p.m.",
        "Then it rained.",
      ]);
    });

    it("keeps decimals, and ellipses that are followed by lower case", () => {
      expect(
        splitSentences("It cost $5.50 today. Wait... then he came back. Why...? Because.", "en"),
      ).toEqual(["It cost $5.50 today.", "Wait... then he came back.", "Why...?", "Because."]);
    });

    it("does not split before a lower-case letter, and splits before a digit or a quote", () => {
      expect(splitSentences('He said "Stop." she ran. 12 men came. "Go," he said.', "en")).toEqual([
        'He said "Stop." she ran.',
        "12 men came.",
        '"Go," he said.',
      ]);
    });

    it("keeps closing quotes with their sentence", () => {
      expect(splitSentences('"Is it you?" she asked. "Yes." He nodded.', "en")).toEqual([
        '"Is it you?" she asked.',
        '"Yes."',
        "He nodded.",
      ]);
    });
  });

  describe("Ukrainian", () => {
    it.each([
      [
        "Т. Г. Шевченко народився в Моринцях. Там був маленький двір.",
        ["Т. Г. Шевченко народився в Моринцях.", "Там був маленький двір."],
      ],
      [
        "Це були яблука, груші і т. д. Потім ми пішли.",
        ["Це були яблука, груші і т. д.", "Потім ми пішли."],
      ],
      ["Він жив у м. Києві. Потім виїхав.", ["Він жив у м. Києві.", "Потім виїхав."]],
      ["Див. рис. 3 та табл. 2. Далі.", ["Див. рис. 3 та табл. 2.", "Далі."]],
      [
        "Вулиця ім. Франка була тиха. Але недовго.",
        ["Вулиця ім. Франка була тиха.", "Але недовго."],
      ],
      ["Це все і т. п. і ін. Кінець.", ["Це все і т. п. і ін.", "Кінець."]],
    ])("does not break inside %j", (text, expected) => {
      expect(splitSentences(text, "uk")).toEqual(expected);
    });

    it("splits a dialogue after a stop and a dash", () => {
      expect(splitSentences("— Привіт. — Привіт.", "uk")).toEqual(["— Привіт.", "— Привіт."]);
    });
  });

  describe("Russian", () => {
    it.each([
      [
        "А. С. Пушкин родился в Москве. Он жил там.",
        ["А. С. Пушкин родился в Москве.", "Он жил там."],
      ],
      ["Яблоки, груши и т. д. Потом мы ушли.", ["Яблоки, груши и т. д.", "Потом мы ушли."]],
      ["Мы жили в г. Москве. Потом уехали.", ["Мы жили в г. Москве.", "Потом уехали."]],
      ["Т. е. так. Потом иначе.", ["Т. е. так.", "Потом иначе."]],
      ["Школа им. Пушкина стоит тут. Рядом парк.", ["Школа им. Пушкина стоит тут.", "Рядом парк."]],
      ["Он ушёл, и т. п. Все молчали.", ["Он ушёл, и т. п.", "Все молчали."]],
    ])("does not break inside %j", (text, expected) => {
      expect(splitSentences(text, "ru")).toEqual(expected);
    });
  });

  describe("words that look like abbreviations", () => {
    it("splits after words that are not abbreviations", () => {
      expect(splitSentences("They sat. Then they left. It was the sun. We went.", "en")).toEqual([
        "They sat.",
        "Then they left.",
        "It was the sun.",
        "We went.",
      ]);
      expect(splitSentences("Він ел рис. Потом ушёл.", "ru")).toEqual([
        "Він ел рис.",
        "Потом ушёл.",
      ]);
      expect(splitSentences("They filled the gal. Then left on Wed. Next day.", "en")).toEqual([
        "They filled the gal.",
        "Then left on Wed.",
        "Next day.",
      ]);
    });

    it("splits after a capital letter that is not an initial: a word that starts sentences follows", () => {
      expect(
        splitSentences("It was Plan B. Then he left. It was Plan C. He stayed.", "en"),
      ).toEqual(["It was Plan B.", "Then he left.", "It was Plan C.", "He stayed."]);
      expect(splitSentences("Це був план Б. Потім він пішов.", "uk")).toEqual([
        "Це був план Б.",
        "Потім він пішов.",
      ]);
    });

    it("still keeps names with their initials", () => {
      expect(splitSentences("C. S. Lewis wrote it. J. Smith read it.", "en")).toEqual([
        "C. S. Lewis wrote it.",
        "J. Smith read it.",
      ]);
    });

    it("does not split between two abbreviations that end a name", () => {
      expect(splitSentences("The Co. Ltd. is closed. Next.", "en")).toEqual([
        "The Co. Ltd. is closed.",
        "Next.",
      ]);
    });
  });

  it("loses nothing", () => {
    const text = "Mr. Smith left. J. R. R. Tolkien stayed... Why? Because etc. and so on! The end.";
    expect(splitSentences(text, "en").join(" ")).toBe(text);
  });
});
