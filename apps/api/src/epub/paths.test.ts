import { describe, expect, it } from "vitest";
import { resolveHref } from "./paths.js";

describe("resolveHref", () => {
  it("resolves relative to the base file and splits the fragment", () => {
    expect(resolveHref("OEBPS/nav.xhtml", "text/ch1.xhtml#sec")).toEqual({
      path: "OEBPS/text/ch1.xhtml",
      fragment: "sec",
    });
    expect(resolveHref("content.opf", "a.xhtml")).toEqual({ path: "a.xhtml", fragment: null });
  });

  it("decodes percent escapes", () => {
    expect(resolveHref("OEBPS/c.opf", "Chapter%201.xhtml")?.path).toBe("OEBPS/Chapter 1.xhtml");
  });

  it("treats a bare fragment as the base file", () => {
    expect(resolveHref("OEBPS/a.xhtml", "#x")).toEqual({ path: "OEBPS/a.xhtml", fragment: "x" });
  });

  it.each([
    "../../etc/passwd",
    "../x.xhtml",
    "https://example.com/a",
    "//host/a",
    "",
    "mailto:a@b",
  ])("rejects %j", (href) => {
    expect(resolveHref("a.xhtml", href)).toBeNull();
  });

  it("keeps ../ that stays inside the archive", () => {
    expect(resolveHref("OEBPS/text/a.xhtml", "../images/c.png")?.path).toBe("OEBPS/images/c.png");
  });
});
