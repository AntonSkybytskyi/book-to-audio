import { describe, expect, it } from "vitest";
import { chunkText } from "../tts/chunk.js";
import { prepareForSpeech, splitLongParagraph, MAX_PARAGRAPH_CHARS } from "./index.js";
import { splitSentences } from "./sentences.js";

/**
 * A regular expression that backtracks over a run of one character is quadratic: four times the
 * text takes sixteen times as long. These tests compare the time for a text with the time for a
 * quarter of it, so a busy machine, which slows both, does not fail them; a rule that runs away
 * does, however fast the machine is.
 */
const best = (run: () => unknown, attempts = 3): number => {
  let fastest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const started = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
};

/** Below this a text is too quick to measure and nothing is asked of it. */
const MEASURABLE_MS = 12;
/** Linear is 4; quadratic is 16. */
const MAX_RATIO = 9;

/** The ratio of the time at four times the size to the time at the base size (1 when too quick to tell). */
const growth = (run: (size: number) => unknown, size: number): number => {
  const small = best(() => run(size));
  const large = best(() => run(size * 4));
  return large < MEASURABLE_MS ? 1 : large / Math.max(small, 2);
};

describe("sentence splitting on runs of stops", () => {
  it.each([
    ["dots", ".", "", 12_500, "en"],
    ["dots and a letter", ".", "x", 12_500, "en"],
    ["question and exclamation marks and a letter", "?!", "x", 6000, "en"],
    ["ellipses and a letter in Ukrainian", "\u2026", "x", 6000, "uk"],
    ["dots and spaces", ". ", "", 5000, "en"],
    ["initials", "А. ", "", 5000, "uk"],
    ["quotes after stops", '."', "x", 4000, "en"],
  ])("grows linearly with a run of %s", (_name, unit, tail, size, language) => {
    const text = (n: number) => unit.repeat(n) + tail;

    expect(growth((n) => splitSentences(text(n), language), size)).toBeLessThan(MAX_RATIO);
  });

  it("is quick on 200,000 dots, 100,000 question and exclamation marks and 50,000 ellipses", () => {
    // Not a timing assertion: splitting them gives the same answer as the quarter, in pieces.
    expect(splitSentences(".".repeat(200_000), "en").join("").length).toBe(200_000);
    expect(splitSentences("?!".repeat(100_000), "en").join("").length).toBe(200_000);
    expect(splitSentences("…".repeat(50_000), "uk").join("").length).toBe(50_000);
  });
});

describe("text preparation on hostile text", () => {
  // Unit of the shape; the text is repeated up to the size of one piece (a paragraph is cut at
  // MAX_PARAGRAPH_CHARS), so a rule that is slow on a piece shows as growth between sizes.
  const SHAPES: [string, string, string?][] = [
    ["digits", "1"],
    ["digits and an ending", "1", "-й"],
    ["digits and a letter", "1", "x"],
    ["digits and a stop", "1", "."],
    ["groups of digits", "1 111 "],
    ["digits and dots", "1."],
    ["digits and dashes", "1-"],
    ["digits and commas", "1,"],
    ["dots", "."],
    ["spaces", " "],
    ["hyphens", "-"],
    ["Roman letters", "I"],
    ["Roman numerals", "XIV "],
    ["Cyrillic Roman numerals", "ХІХ–ХХ "],
    ["ranges", "1914–1918 "],
    ["dates", "с 5 по 10 июня "],
    ["centuries", "XIX–XX ст. "],
    ["percent", "10-15%"],
    ["currency", "10-20 грн "],
    ["headings", "Глава "],
    ["initials", "А. "],
    ["ellipses", "…"],
    ["a long word", "я"],
    ["notes glued to words", "слово1 "],
    ["symbols", "(/)[]×÷°%$"],
    ["Latin acronyms", "USA "],
    ["newlines", "\n \n"],
    ["fractions", "1/2 "],
    ["phone numbers", "555-1234 "],
    ["locatives", "на 5 сторінці "],
    ["decades", "1960–1970-х "],
  ];

  it.each(["en", "uk", "ru"])("%s: no shape grows faster than its size", (language) => {
    const quadratic: string[] = [];
    for (const [name, unit, tail = ""] of SHAPES) {
      const piece = (chars: number) =>
        unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars) + tail;
      const ratio = growth((chars) => prepareForSpeech(piece(chars), language), 1200);
      if (ratio >= MAX_RATIO) quadratic.push(`${name}: x${ratio.toFixed(1)}`);
    }
    expect(quadratic).toEqual([]);
  });

  it.each(["en", "uk", "ru"])(
    "%s: a long text is cut into pieces, so it grows linearly",
    (language) => {
      const make = (n: number) =>
        chunkText(
          prepareForSpeech("1-".repeat(n) + " слово. ".repeat(n), language),
          1000,
          language,
        );

      expect(growth(make, 1500)).toBeLessThan(MAX_RATIO);
    },
  );

  it("survives random mixes of the characters the rules look at", () => {
    const pieces = [
      "1",
      "12",
      "2020",
      " ",
      ".",
      ", ",
      "-",
      "–",
      "—",
      "I",
      "V",
      "X",
      "IV",
      "ХІХ",
      "А. ",
      "т. д. ",
      "%",
      "$",
      "№",
      "°",
      "(",
      ")",
      "/",
      "\n",
      "\n\n",
      "…",
      "й",
      "-й",
      "-го",
      "-х",
      "XIX–XX ",
      "1914–1918 ",
      "г. ",
      "руб. ",
      "грн ",
      "Глава ",
      "розділ ",
      "с ",
      "по ",
      "до ",
      "июня ",
      "червня ",
      "в ",
      "у ",
      "ст. ",
      "в. ",
      "Mr. ",
      "Jr. ",
      "Part ",
      "1990-е ",
      "20-ті ",
      "слово",
      "Word",
      "USA",
      "A4",
      "1/2",
      "×",
      "на ",
      "сторінці ",
    ];
    // A fixed generator: the same texts on every run.
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (const language of ["en", "uk", "ru"]) {
      for (let round = 0; round < 4; round++) {
        let text = "";
        for (let i = 0; i < 6000; i++) text += pieces[next() % pieces.length];
        const chunks = chunkText(prepareForSpeech(text, language), 1000, language);
        expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
      }
    }
  });
});

describe("paragraphs that are too long", () => {
  it("are cut so that the pieces joined are the text", () => {
    const text = "Слово. ".repeat(3000) + "x".repeat(12_000) + " ".repeat(3) + "end";

    const pieces = splitLongParagraph(text);

    expect(pieces.join("")).toBe(text);
    expect(pieces.every((piece) => piece.length <= MAX_PARAGRAPH_CHARS)).toBe(true);
    expect(pieces.length).toBeGreaterThan(3);
  });

  it("are cut at a stop when there is one, and at a space otherwise", () => {
    const sentences = `${"a".repeat(3000)}. ${"b".repeat(3000)}. ${"c".repeat(3000)}.`;
    const words = Array.from({ length: 1500 }, () => "word").join(" ");

    expect(splitLongParagraph(sentences)[0]).toBe(`${"a".repeat(3000)}.`);
    const wordPieces = splitLongParagraph(words);
    expect(wordPieces[0]?.endsWith("word")).toBe(true);
    expect(wordPieces.every((p) => p.length <= MAX_PARAGRAPH_CHARS)).toBe(true);
  });

  it("are not cut inside a surrogate pair when there is nowhere else to cut", () => {
    // 4,999 letters and then emoji: the hard cut at 5,000 would fall between the halves of one.
    const text = "x".repeat(MAX_PARAGRAPH_CHARS - 1) + "😀".repeat(3000);

    const pieces = splitLongParagraph(text);

    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) {
      // No lone surrogate: encoding the piece and decoding it gives the piece back.
      expect(new TextDecoder().decode(new TextEncoder().encode(piece))).toBe(piece);
    }
  });

  it("leave a normal paragraph in one piece", () => {
    expect(splitLongParagraph("Short one.")).toEqual(["Short one."]);
    expect(splitLongParagraph("")).toEqual([]);
  });
});
