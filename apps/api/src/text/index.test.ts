import { describe, expect, it } from "vitest";
import { prepareForSpeech, TEXT_PROCESSING_VERSION } from "./index.js";

describe("prepareForSpeech", () => {
  it("works one paragraph at a time and keeps the blank lines", () => {
    expect(prepareForSpeech("IV\n\nIt was 1999.\n\n\nChapter II", "en")).toBe(
      "4\n\nIt was 1999.\n\n\nChapter 2",
    );
  });

  it("applies the rules of the book's language", () => {
    expect(prepareForSpeech("У 1999 році", "uk")).toBe(
      "У тисяча дев'ятсот дев'яносто дев'ятому році",
    );
    expect(prepareForSpeech("в 1999 году", "ru")).toBe("в тысяча девятьсот девяносто девятом году");
    expect(prepareForSpeech("in 1999", "en")).toBe("in nineteen ninety-nine");
  });

  it("only cleans the text of a language it has no rules for", () => {
    expect(prepareForSpeech("Zwei   Wörter­ in 1999.", "de")).toBe("Zwei Wörter in 1999.");
  });

  it("removes invisible characters and squeezes spaces, not line breaks", () => {
    expect(prepareForSpeech("a​b  c d\n e", "en")).toBe("ab c d\ne");
  });

  it("has a version that the chunk records follow", () => {
    expect(Number.isInteger(TEXT_PROCESSING_VERSION)).toBe(true);
    expect(TEXT_PROCESSING_VERSION).toBeGreaterThanOrEqual(1);
  });
});
