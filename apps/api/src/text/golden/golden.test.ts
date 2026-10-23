import { describe, expect, it } from "vitest";
import { prepareForSpeech } from "../index.js";
import { EN_GOLDEN } from "./en.js";
import { RU_GOLDEN } from "./ru.js";
import { UK_GOLDEN } from "./uk.js";

// What the rules must give for real sentences, in all three languages. A change that shows up here
// is a change in what listeners hear: review it, then update the expectation and bump
// `TEXT_PROCESSING_VERSION` (`golden-hash.test.ts` insists on the second).
describe.each([
  ["English", "en", EN_GOLDEN],
  ["Russian", "ru", RU_GOLDEN],
  ["Ukrainian", "uk", UK_GOLDEN],
] as const)("%s golden sentences", (_name, language, groups) => {
  describe.each(groups.map((group) => [group.name, group.cases] as const))(
    "%s",
    (_group, cases) => {
      it.each(cases)("%j", (input, expected) => {
        expect(prepareForSpeech(input, language)).toBe(expected);
      });
    },
  );
});
