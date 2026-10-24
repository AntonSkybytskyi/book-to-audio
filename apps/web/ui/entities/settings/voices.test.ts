import type { LanguageVoiceView } from "@book-to-audio/contracts";
import { describe, expect, it } from "vitest";
import { voiceNote } from "./voices";

const row = (overrides: Partial<LanguageVoiceView> = {}): LanguageVoiceView => ({
  language: "uk",
  voice: "piper:uk",
  chosen: null,
  options: [{ id: "piper:uk", service: "piper", name: "Lada" }],
  ...overrides,
});

describe("voiceNote", () => {
  it("says nothing while the default or the chosen voice reads the language", () => {
    expect(voiceNote(row())).toBeNull();
    expect(voiceNote(row({ chosen: "piper:uk" }))).toBeNull();
  });

  it("says the language waits while its service has not answered", () => {
    expect(voiceNote(row({ voice: null, chosen: "other:uk", options: [] }))).toMatch(
      /has not answered yet/,
    );
  });

  it("names the voice that reads the language while the chosen one is gone", () => {
    expect(voiceNote(row({ chosen: "piper:gone" }))).toBe(
      "The chosen voice is not available now, so Lada reads this language until it is back.",
    );
  });
});
