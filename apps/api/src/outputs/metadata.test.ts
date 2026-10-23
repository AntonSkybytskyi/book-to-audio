import { describe, expect, it } from "vitest";
import { buildFfmetadata, chapterMarks, clipUtf8, cleanTag, escapeMetadata } from "./metadata.js";

describe("escapeMetadata", () => {
  it("puts a backslash before =, ;, # and \\", () => {
    expect(escapeMetadata("a=b;c#d\\e")).toBe(["a\\=b", "\\;c", "\\#d\\\\e"].join(""));
  });

  it("escapes a line break instead of ending the value there", () => {
    expect(escapeMetadata("one\ntwo")).toBe("one\\\ntwo");
    expect(escapeMetadata("one\r\ntwo\rthree")).toBe("one\\\ntwo\\\nthree");
  });

  it("drops control characters, which cannot be part of a tag", () => {
    expect(escapeMetadata("a\u0000b\u0007c\u001bd\u007fe f")).toBe("abcdef");
  });

  it("leaves letters of every script alone", () => {
    expect(escapeMetadata("Глава «Київ» 第一章 é")).toBe("Глава «Київ» 第一章 é");
  });
});

describe("cleanTag", () => {
  it("keeps line breaks and tabs, and drops what cannot be passed on", () => {
    expect(cleanTag("a\tb\r\nc\u0000d")).toBe("a\tb\ncd");
  });
});

describe("clipUtf8", () => {
  it("leaves a value that fits", () => {
    expect(clipUtf8("short", 10)).toBe("short");
  });

  it("cuts to the byte limit without splitting a character, and marks the cut", () => {
    const clipped = clipUtf8("Київ".repeat(100), 40);

    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(40);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped).not.toContain("�");
  });

  it("does not split an emoji", () => {
    const clipped = clipUtf8("😀".repeat(10), 14);

    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(14);
    expect([...clipped].every((char) => char === "😀" || char === "…")).toBe(true);
  });
});

describe("chapterMarks", () => {
  it("lays the chapters end to end from their real lengths", () => {
    const marks = chapterMarks([
      { title: "A", durationSeconds: 7.378 },
      { title: "B", durationSeconds: 14.5 },
      { title: "C", durationSeconds: 0.0004 },
    ]);

    expect(marks).toEqual([
      { title: "A", startMs: 0, endMs: 7378 },
      { title: "B", startMs: 7378, endMs: 21878 },
      { title: "C", startMs: 21878, endMs: 21878 },
    ]);
  });

  it("does not let rounding build up over a long book", () => {
    // 3 hours of chapters that are 72.3456789 s: each rounded boundary is within 0.5 ms of the true sum.
    const chapters = Array.from({ length: 150 }, (_, i) => ({
      title: `C${i}`,
      durationSeconds: 72.3456789,
    }));

    const marks = chapterMarks(chapters);

    expect(marks.at(-1)?.startMs).toBe(Math.round(72.3456789 * 149 * 1000));
    expect(marks.at(-1)?.endMs).toBe(Math.round(72.3456789 * 150 * 1000));
    for (const [i, mark] of marks.entries()) {
      expect(Math.abs(mark.startMs - 72345.6789 * i)).toBeLessThanOrEqual(0.6);
    }
    // Each chapter starts where the one before ended.
    expect(marks.slice(1).map((mark) => mark.startMs)).toEqual(
      marks.slice(0, -1).map((mark) => mark.endMs),
    );
  });
});

describe("buildFfmetadata", () => {
  const marks = [{ title: "One", startMs: 0, endMs: 1500 }];

  it("writes the tags and one chapter block per chapter", () => {
    expect(buildFfmetadata({ title: "Book", artist: "Ann", album: "Book", chapters: marks })).toBe(
      ";FFMETADATA1\ntitle=Book\nartist=Ann\nalbum=Book\n" +
        "[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1500\ntitle=One\n",
    );
  });

  it("leaves the artist out when the author is unknown", () => {
    const text = buildFfmetadata({ title: "B", artist: null, album: "B", chapters: marks });

    expect(text).not.toContain("artist");
  });

  it("escapes every title, so an EPUB title cannot add lines of its own", () => {
    const hostile = "x\n[CHAPTER]\nSTART=0\ntitle=pwned";
    const text = buildFfmetadata({
      title: hostile,
      artist: "a=b",
      album: "c;d",
      chapters: [{ title: hostile, startMs: 0, endMs: 10 }],
    });

    const lines = text.split("\n");
    // A line that starts a new block or a key is a line ffmpeg would act on; escaped line breaks leave none.
    const unescapedBreaks = lines.filter((line, i) => i > 0 && !lines[i - 1]?.endsWith("\\"));
    expect(unescapedBreaks.filter((line) => line === "[CHAPTER]")).toHaveLength(1);
    expect(unescapedBreaks.filter((line) => line.startsWith("START="))).toHaveLength(1);
    expect(text).toContain("artist=a\\=b");
    expect(text).toContain("album=c\\;d");
  });

  it("names a chapter whose title is empty", () => {
    const text = buildFfmetadata({
      title: "B",
      artist: null,
      album: "B",
      chapters: [{ title: "  ", startMs: 0, endMs: 10 }],
    });

    expect(text).toContain("title=Chapter 1\n");
  });

  it("keeps a chapter title within what the chapter atom can hold", () => {
    const text = buildFfmetadata({
      title: "B",
      artist: null,
      album: "B",
      chapters: [{ title: "Ж".repeat(500), startMs: 0, endMs: 10 }],
    });
    const title = text.split("\n").filter((line) => line.startsWith("title="))[1] ?? "";

    expect(Buffer.byteLength(title.slice("title=".length))).toBeLessThanOrEqual(255);
  });
});
