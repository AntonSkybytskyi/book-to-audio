import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk.js";

describe("chunkText", () => {
  it("packs whole sentences up to the limit", () => {
    const text = "One two. Three four. Five six. Seven eight.";

    expect(chunkText(text, 22)).toEqual(["One two. Three four.", "Five six. Seven eight."]);
  });

  it("returns one chunk when everything fits", () => {
    expect(chunkText("Short text.", 100)).toEqual(["Short text."]);
  });

  it("keeps paragraph breaks as single newlines inside a chunk", () => {
    expect(chunkText("First para.\n\nSecond para.", 100)).toEqual(["First para.\nSecond para."]);
  });

  it("starts a new chunk when the next paragraph does not fit", () => {
    expect(chunkText("First para.\n\nSecond para.", 15)).toEqual(["First para.", "Second para."]);
  });

  it("splits a sentence longer than the limit on whitespace", () => {
    const sentence = "alpha beta gamma delta epsilon zeta eta theta";

    const chunks = chunkText(sentence, 16);

    expect(chunks).toEqual(["alpha beta gamma", "delta epsilon", "zeta eta theta"]);
    expect(chunks.join(" ")).toBe(sentence);
  });

  it("cuts a single word that is longer than the limit", () => {
    expect(chunkText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("never exceeds the limit and never loses words", () => {
    const text = Array.from(
      { length: 80 },
      (_, i) => `Sentence number ${i} has some words, really.`,
    ).join(" ");

    const chunks = chunkText(text, 120);

    expect(chunks.every((c) => c.length <= 120)).toBe(true);
    expect(chunks.join(" ").split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it("returns nothing for empty text", () => {
    expect(chunkText("  \n\n ", 100)).toEqual([]);
  });

  it("rejects a limit below 1", () => {
    expect(() => chunkText("x", 0)).toThrow(RangeError);
  });
});
