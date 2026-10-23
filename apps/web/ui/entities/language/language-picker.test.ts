import { describe, expect, it } from "vitest";
import {
  languageNote,
  languageSettingsMessage,
  needsLanguageChoice,
  pickerOptions,
} from "./language-picker";

const VOICES = ["en", "uk", "ru"];

describe("pickerOptions", () => {
  it("lists the shown languages", () => {
    expect(pickerOptions(["en", "uk"], "en", VOICES)).toEqual([
      { code: "en", label: "English" },
      { code: "uk", label: "Ukrainian" },
    ]);
  });

  it("adds the book's own language when it is hidden, and says so", () => {
    expect(pickerOptions(["en", "uk"], "ru", VOICES)).toEqual([
      { code: "en", label: "English" },
      { code: "uk", label: "Ukrainian" },
      { code: "ru", label: "Russian (hidden in settings)" },
    ]);
  });

  it("keeps the languages in their usual order", () => {
    expect(pickerOptions(["ru", "en"], "uk", VOICES).map((o) => o.code)).toEqual([
      "en",
      "uk",
      "ru",
    ]);
  });

  it("does not list a hidden language the book is not in", () => {
    expect(pickerOptions(["en"], "en", VOICES).map((o) => o.code)).toEqual(["en"]);
  });

  it("marks a language that has no voice", () => {
    expect(pickerOptions(["en", "uk"], "en", ["en"])).toEqual([
      { code: "en", label: "English" },
      { code: "uk", label: "Ukrainian (no voice yet)" },
    ]);
    expect(pickerOptions(["en"], "ru", ["en"])[1]?.label).toBe(
      "Russian (hidden in settings, no voice yet)",
    );
  });
});

describe("languageNote", () => {
  it("says what was detected", () => {
    expect(languageNote("detected", "uk", "uk", false)).toMatchObject({
      headline: "Detected: Ukrainian",
      tone: "info",
    });
  });

  it("mentions metadata that disagrees with the text", () => {
    const note = languageNote("detected", "ru", "en", false);

    expect(note.headline).toBe("Detected: Russian");
    expect(note.text).toContain("metadata says English, but the text is Russian");
  });

  it("asks to check a language taken from the metadata", () => {
    expect(languageNote("metadata", "uk", "uk", false)).toMatchObject({
      headline: "From the book's metadata: Ukrainian",
      tone: "check",
    });
  });

  it("says it could not detect when it did not", () => {
    const note = languageNote("unknown", "en", null, false);

    expect(note.headline).toBe("Could not detect the language");
    expect(note.text).toContain("Please pick");
    expect(note.tone).toBe("check");
  });

  it("says nothing about the origin once the owner picked a language", () => {
    expect(languageNote("detected", "uk", null, true).headline).toBeNull();
    expect(languageNote("unknown", "en", null, true).headline).toBeNull();
    expect(languageNote("chosen", "ru", null, false).headline).toBeNull();
  });
});

describe("languageSettingsMessage", () => {
  it("lists what is shown", () => {
    expect(languageSettingsMessage(["en"])).toBe("Saved. The language list shows English.");
    expect(languageSettingsMessage(["en", "uk"])).toBe(
      "Saved. The language list shows English and Ukrainian.",
    );
    expect(languageSettingsMessage(["ru", "en", "uk"])).toBe(
      "Saved. The language list shows English, Ukrainian and Russian.",
    );
  });
});

describe("needsLanguageChoice", () => {
  it("asks for a choice only while the language is unknown and nothing has been picked", () => {
    expect(needsLanguageChoice("unknown", false)).toBe(true);
    expect(needsLanguageChoice("unknown", true)).toBe(false);
    for (const source of ["detected", "metadata", "chosen"] as const) {
      expect(needsLanguageChoice(source, false)).toBe(false);
    }
  });
});
