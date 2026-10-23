import { describe, expect, it } from "vitest";
import { languageName } from "./language-names";

describe("languageName", () => {
  it("names languages and passes unknown codes through", () => {
    expect(languageName("uk")).toBe("Ukrainian");
    expect(languageName("de")).toBe("de");
  });
});
