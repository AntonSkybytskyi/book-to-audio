import { describe, expect, it } from "vitest";
import {
  asciiDownloadName,
  chapterFileNames,
  contentDisposition,
  downloadFileName,
  paddedNumber,
  sanitizeFileName,
} from "./names.js";

describe("sanitizeFileName", () => {
  it("keeps Cyrillic, accents and CJK", () => {
    expect(sanitizeFileName("Глава перша: Київ")).toBe("Глава перша Київ");
    expect(sanitizeFileName("Café déjà vu")).toBe("Café déjà vu");
    expect(sanitizeFileName("第一章 雨")).toBe("第一章 雨");
  });

  it("removes path separators and the characters Windows refuses", () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
  });

  it("cannot be used to climb out of a folder", () => {
    const name = sanitizeFileName("../../etc/passwd");

    expect(name).toBe("etc passwd");
    expect(name).not.toMatch(/[\\/]/);
    expect(sanitizeFileName("..")).toBe("Untitled");
  });

  it("turns line breaks, tabs and control characters into single spaces or nothing", () => {
    expect(sanitizeFileName("one\ntwo\r\n\tthree")).toBe("one two three");
    expect(sanitizeFileName("a\u0000b\u0007c")).toBe("a b c");
  });

  it("drops invisible characters that can disguise a name, but keeps joiners", () => {
    expect(sanitizeFileName("gpj.‮exe")).toBe("gpj. exe");
    expect(sanitizeFileName("​hidden⁦")).toBe("hidden");
    expect(sanitizeFileName("क्‍ष")).toBe("क्‍ष");
  });

  it("strips leading dots and trailing dots and spaces", () => {
    expect(sanitizeFileName("...hidden")).toBe("hidden");
    expect(sanitizeFileName("  .. spaced out . . ")).toBe("spaced out");
    expect(sanitizeFileName("Chapter 1...")).toBe("Chapter 1");
  });

  it("does not leave a reserved Windows device name", () => {
    expect(sanitizeFileName("CON")).toBe("_CON");
    expect(sanitizeFileName("nul")).toBe("_nul");
    expect(sanitizeFileName("COM1.txt")).toBe("_COM1.txt");
    expect(sanitizeFileName("LPT9")).toBe("_LPT9");
    expect(sanitizeFileName("Console")).toBe("Console");
  });

  it("cuts at 100 characters without splitting an emoji or an accent", () => {
    const long = sanitizeFileName("é".repeat(300));
    const decomposed = sanitizeFileName("é".repeat(300));
    const emoji = sanitizeFileName("👩‍👩‍👧".repeat(300));

    expect([...new Intl.Segmenter().segment(long)]).toHaveLength(100);
    expect([...new Intl.Segmenter().segment(emoji)].length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(200);
    expect(decomposed.normalize("NFC")).toBe(decomposed);
    expect(emoji).not.toContain("�");
  });

  it("keeps a name in bytes too, since file systems count bytes", () => {
    expect(Buffer.byteLength(sanitizeFileName("Ж".repeat(300)))).toBeLessThanOrEqual(200);
  });

  it("falls back for a title with nothing left", () => {
    expect(sanitizeFileName("")).toBe("Untitled");
    expect(sanitizeFileName(" : / : ")).toBe("Untitled");
    expect(sanitizeFileName("***", "Chapter")).toBe("Chapter");
  });
});

describe("chapterFileNames", () => {
  it("numbers the chapters in order, zero padded to at least two digits", () => {
    expect(chapterFileNames(["Start", "Middle"])).toEqual(["01 - Start.webm", "02 - Middle.webm"]);
  });

  it("pads to the width of the chapter count", () => {
    const titles = Array.from({ length: 120 }, (_, i) => `T${i + 1}`);

    const names = chapterFileNames(titles);

    expect(names[0]).toBe("001 - T1.webm");
    expect(names[119]).toBe("120 - T120.webm");
    expect(paddedNumber(7, 9)).toBe("07");
    expect(paddedNumber(7, 1000)).toBe("0007");
  });

  it("keeps same titles apart and names an unusable title Chapter", () => {
    expect(chapterFileNames(["Same", "Same", "???"])).toEqual([
      "01 - Same.webm",
      "02 - Same.webm",
      "03 - Chapter.webm",
    ]);
  });

  it("never produces two names that differ only in case", () => {
    const names = chapterFileNames(["A", "a"]).map((name) => name.toLowerCase());

    expect(new Set(names).size).toBe(2);
  });
});

describe("downloadFileName", () => {
  it("is Title - Author.m4b and Title - Author (WebM).zip", () => {
    const book = { title: "Field Notes on Rain", author: "M. Okafor" };

    expect(downloadFileName("m4b", book)).toBe("Field Notes on Rain - M. Okafor.m4b");
    expect(downloadFileName("zip", book)).toBe("Field Notes on Rain - M. Okafor (WebM).zip");
  });

  it("leaves the author out when there is none", () => {
    expect(downloadFileName("m4b", { title: "Alone", author: null })).toBe("Alone.m4b");
    expect(downloadFileName("zip", { title: "Alone", author: " / " })).toBe("Alone (WebM).zip");
  });

  it("keeps title and author together within about 200 bytes, in either script", () => {
    const long = { title: "Ж".repeat(300), author: "é".repeat(300) };

    for (const kind of ["m4b", "zip"] as const) {
      expect(Buffer.byteLength(downloadFileName(kind, long))).toBeLessThanOrEqual(200);
      expect(Buffer.byteLength(asciiDownloadName(kind, long))).toBeLessThanOrEqual(200);
    }
    const emoji = { title: "👩‍👩‍👧".repeat(100), author: "👩‍👩‍👧".repeat(100) };
    expect(Buffer.byteLength(downloadFileName("zip", emoji))).toBeLessThanOrEqual(200);
  });

  it("is safe whatever the title is", () => {
    expect(downloadFileName("m4b", { title: "../x\n", author: "a/b" })).toBe("x - a b.m4b");
  });
});

describe("contentDisposition", () => {
  it("has the given ASCII filename and the real name as filename*", () => {
    const header = contentDisposition("Київ - Автор.m4b", "Kyiv - Avtor.m4b");

    expect(header).toBe(
      `attachment; filename="Kyiv - Avtor.m4b"; filename*=UTF-8''%D0%9A%D0%B8%D1%97%D0%B2%20-%20%D0%90%D0%B2%D1%82%D0%BE%D1%80.m4b`,
    );
  });

  it("cannot break out of the quoted filename, whatever it is given", () => {
    const header = contentDisposition("x.m4b", 'a"b\\c%d\r\né.m4b');

    expect(header.split(";")[1]).toBe(' filename="a_b_c_d___.m4b"');
  });

  it("escapes the characters RFC 5987 does not allow unescaped", () => {
    expect(contentDisposition("it's (a) *test*.m4b", "x.m4b")).toContain(
      "filename*=UTF-8''it%27s%20%28a%29%20%2Atest%2A.m4b",
    );
  });

  it("does not throw on a lone surrogate", () => {
    expect(() => contentDisposition("a\ud800b.m4b", "x.m4b")).not.toThrow();
  });
});

describe("asciiDownloadName", () => {
  it("is the real name when it is plain ASCII, with accents dropped otherwise", () => {
    expect(asciiDownloadName("m4b", { title: "Field Notes", author: "M. Okafor" })).toBe(
      "Field Notes - M. Okafor.m4b",
    );
    expect(asciiDownloadName("zip", { title: "Café Society", author: "Zoë" })).toBe(
      "Cafe Society - Zoe (WebM).zip",
    );
  });

  it("transliterates Ukrainian and Russian instead of printing underscores", () => {
    expect(
      asciiDownloadName("m4b", { title: "Тіні забутих предків", author: "Коцюбинський" }),
    ).toBe("Tini zabutykh predkiv - Kotsiubynskyi.m4b");
    expect(
      asciiDownloadName("zip", { title: "Война и мир", author: "Лев Толстой", language: "ru" }),
    ).toBe("Voyna i mir - Lev Tolstoy (WebM).zip");
  });

  it("leaves out a title or author with no Latin letters after that (CJK) instead of underscores", () => {
    expect(asciiDownloadName("zip", { title: "日本語", author: "Coetzee" })).toBe(
      "audiobook - Coetzee (WebM).zip",
    );
    expect(asciiDownloadName("zip", { title: "日本語", author: null })).toBe(
      "audiobook (WebM).zip",
    );
  });

  it("keeps the Latin part of a mixed title and cannot break out of the quotes", () => {
    expect(asciiDownloadName("m4b", { title: 'Київ "Kyiv" 100%', author: null })).toBe(
      "Kyiv Kyiv 100_.m4b",
    );
  });
});
