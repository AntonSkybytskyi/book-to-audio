import { describe, expect, it } from "vitest";
import { foldLookalikes } from "./homoglyphs.js";

describe("foldLookalikes", () => {
  it("makes the Latin look-alikes in a Cyrillic word Cyrillic", () => {
    expect(foldLookalikes("Cкоро", true)).toBe("Скоро");
    expect(foldLookalikes("Maма", false)).toBe("Мама");
    expect(foldLookalikes("тeкcт", false)).toBe("текст");
  });

  it("maps i and I only in Ukrainian text", () => {
    expect(foldLookalikes("Українcька ciль", true)).toBe("Українська сіль");
    expect(foldLookalikes("ciль", false)).toBe("сiль");
  });

  it("leaves words that are all Latin or all Cyrillic", () => {
    const text = "Hello world Привіт, світе! OK";
    expect(foldLookalikes(text, true)).toBe(text);
    expect(foldLookalikes(text, false)).toBe(text);
  });

  it("leaves letters that have no look-alike", () => {
    expect(foldLookalikes("слоbо", true)).toBe("слоbо");
  });
});
