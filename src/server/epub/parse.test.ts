import { describe, expect, it } from "vitest";
import { zipEpub, xhtml, CONTAINER_XML } from "./testing/build-epub.js";
import { makeCover } from "./testing/png.js";
import { buildSampleBook, lighthouseBook, rainBook } from "./testing/sample-books.js";
import { EpubError } from "./errors.js";
import { parseEpub } from "./parse.js";
import { DEFAULT_LIMITS } from "./types.js";

const rejection = async (data: Buffer, limits = DEFAULT_LIMITS) => {
  const error = await parseEpub(data, limits).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(EpubError);
  return error as EpubError;
};

const encryption = (algorithm: string) =>
  `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">` +
  `<enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData>` +
  `<enc:CipherReference URI="OEBPS/c1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`;

/** Tests that parse a huge document: CPU-bound, so they get room when the machine is busy. */
const HEAVY_TEST_MS = 30_000;

describe("parseEpub: EPUB 3", () => {
  it("reads metadata, cover and chapters from the nav document", async () => {
    const book = await parseEpub(await lighthouseBook());

    expect(book).toMatchObject({
      title: "The Lighthouse Keeper's Almanac",
      author: "Mira Halvorsen",
      language: "en",
    });
    expect(book.cover?.mime).toBe("image/png");
    expect(book.chapters.map((c) => c.title)).toEqual([
      "The Last Boat",
      "A Ledger of Weather",
      "The Fog Signal",
      "What the Tide Left",
    ]);
  });

  it("drops footnotes and the notes page from the text", async () => {
    const { chapters } = await parseEpub(await lighthouseBook());

    expect(chapters[0]?.text).toContain("watched it go. Nobody had told him");
    expect(chapters.map((c) => c.text).join("\n")).not.toContain("second Thursday");
    expect(chapters[0]?.text.split("\n\n")).toHaveLength(4);
  });
});

describe("parseEpub: EPUB 2", () => {
  it("reads the NCX table of contents and the meta cover", async () => {
    const book = await parseEpub(await rainBook());

    expect(book.language).toBe("en-GB");
    expect(book.cover?.bytes.length).toBeGreaterThan(100);
    expect(book.chapters.map((c) => c.title)).toEqual(["Drizzle", "Downpour", "After the Rain"]);
  });
});

describe("parseEpub: chapter boundaries", () => {
  const base = { version: 3 as const, author: "A", language: null, title: "T" };

  it("falls back to spine order and uses headings as titles", async () => {
    const book = await parseEpub(
      await buildSampleBook({
        ...base,
        toc: "none",
        chapters: [
          { file: "a", title: "A", body: "<h2>Alpha</h2><p>Alpha text.</p>" },
          { file: "blank", title: "B", body: "<img src='x.png'/>" },
          { file: "c", title: "C", body: "<p>No heading here.</p>" },
        ],
      }),
    );

    expect(book.language).toBeNull();
    expect(book.chapters.map((c) => c.title)).toEqual(["Alpha", "C"]);
  });

  it("splits one file at TOC fragments", async () => {
    const book = await parseEpub(
      await buildSampleBook({
        ...base,
        toc: "nav",
        chapters: [
          {
            file: "all",
            title: "All",
            body:
              `<h1 id="a">One</h1><p>First text.</p><p>More one.</p>` +
              `<h1 id="b">Two</h1><p>Second text.</p>`,
          },
        ],
        tocEntries: [
          ["One", "all.xhtml#a"],
          ["Two", "all.xhtml#b"],
        ],
      }),
    );

    expect(book.chapters).toEqual([
      { title: "One", text: "One\n\nFirst text.\n\nMore one." },
      { title: "Two", text: "Two\n\nSecond text." },
    ]);
  });

  it("lets a chapter run across several spine files up to the next entry", async () => {
    const book = await parseEpub(
      await buildSampleBook({
        ...base,
        toc: "ncx",
        version: 2,
        chapters: [
          { file: "c1a", title: "x", body: "<p>One A.</p>" },
          { file: "c1b", title: "x", body: "<p>One B.</p>" },
          { file: "c2", title: "x", body: "<p>Two.</p>" },
        ],
        tocEntries: [
          ["First", "c1a.xhtml"],
          ["Second", "c2.xhtml"],
        ],
      }),
    );

    expect(book.chapters).toEqual([
      { title: "First", text: "One A.\n\nOne B." },
      { title: "Second", text: "Two." },
    ]);
  });

  it("skips entries with no text and ignores entries that point outside the spine", async () => {
    const book = await parseEpub(
      await buildSampleBook({
        ...base,
        toc: "nav",
        chapters: [
          { file: "cover", title: "Cover", body: "<img src='c.png'/>" },
          { file: "c1", title: "One", body: "<p>Text.</p>" },
        ],
        tocEntries: [
          ["Cover", "cover.xhtml"],
          ["One", "c1.xhtml"],
          ["Elsewhere", "missing.xhtml"],
          ["Web", "https://example.com/"],
        ],
      }),
    );

    expect(book.chapters.map((c) => c.title)).toEqual(["One"]);
  });

  it("uses the spine when no TOC entry resolves", async () => {
    const book = await parseEpub(
      await buildSampleBook({
        ...base,
        toc: "nav",
        chapters: [{ file: "c1", title: "One", body: "<h1>One</h1><p>Text.</p>" }],
        tocEntries: [["Gone", "gone.xhtml"]],
      }),
    );

    expect(book.chapters.map((c) => c.title)).toEqual(["One"]);
  });

  it("numbers chapters whose TOC label is empty", async () => {
    const book = await parseEpub(
      await buildSampleBook({
        ...base,
        toc: "nav",
        chapters: [{ file: "c1", title: "One", body: "<p>Text.</p>" }],
        tocEntries: [[" ", "c1.xhtml"]],
      }),
    );

    expect(book.chapters[0]?.title).toBe("Chapter 1");
  });
});

describe("parseEpub: nested and mixed navigation", () => {
  it("flattens nested nav lists and skips the landmarks nav", async () => {
    const nav = xhtml(
      `<nav epub:type="landmarks"><ol><li><a href="c2.xhtml">Start here</a></li></ol></nav>` +
        `<nav epub:type="toc"><ol>` +
        `<li><a href="c1.xhtml">Part One</a><ol><li><a href="c2.xhtml">Chapter A</a></li>` +
        `<li><a href="c3.xhtml">Chapter B</a></li></ol></li></ol></nav>`,
    );
    const book = await parseEpub(
      await buildSampleBook({
        version: 3,
        toc: "nav",
        title: "T",
        author: "A",
        language: "en",
        chapters: [
          { file: "c1", title: "x", body: "<p>Part title page.</p>" },
          { file: "c2", title: "x", body: "<p>Text A.</p>" },
          { file: "c3", title: "x", body: "<p>Text B.</p>" },
        ],
        extraFiles: { "OEBPS/nav.xhtml": nav },
      }),
    );

    expect(book.chapters.map((c) => [c.title, c.text])).toEqual([
      ["Part One", "Part title page."],
      ["Chapter A", "Text A."],
      ["Chapter B", "Text B."],
    ]);
  });

  it("reads nested NCX navPoints and decodes percent-encoded hrefs", async () => {
    const ncx =
      `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>` +
      `<navPoint id="a"><navLabel><text>Outer</text></navLabel><content src="my%20file.xhtml"/>` +
      `<navPoint id="b"><navLabel><text>Inner</text></navLabel><content src="my%20file.xhtml#in"/></navPoint>` +
      `</navPoint></navMap></ncx>`;
    const book = await parseEpub(
      await buildSampleBook({
        version: 2,
        toc: "ncx",
        title: "T",
        author: "A",
        language: "en",
        chapters: [
          { file: "my file", title: "x", body: `<p>Outer text.</p><p id="in">Inner text.</p>` },
        ],
        extraFiles: { "OEBPS/toc.ncx": ncx },
      }),
    );

    expect(book.chapters.map((c) => [c.title, c.text])).toEqual([
      ["Outer", "Outer text."],
      ["Inner", "Inner text."],
    ]);
  });
});

describe("parseEpub: cover", () => {
  it("ignores a cover whose bytes are not a supported image", async () => {
    const book = await parseEpub(
      await buildSampleBook({
        version: 3,
        toc: "nav",
        title: "T",
        author: "A",
        language: "en",
        cover: Buffer.from("<svg onload='alert(1)'/>"),
        chapters: [{ file: "c1", title: "One", body: "<p>Text.</p>" }],
      }),
    );

    expect(book.cover).toBeNull();
  });

  it("keeps a real cover", async () => {
    const png = makeCover([1, 2, 3], [4, 5, 6], 20, 30);
    const book = await parseEpub(
      await buildSampleBook({
        version: 3,
        toc: "nav",
        title: "T",
        author: "A",
        language: "en",
        cover: png,
        chapters: [{ file: "c1", title: "One", body: "<p>Text.</p>" }],
      }),
    );

    expect(book.cover).toEqual({ bytes: png, mime: "image/png" });
  });
});

describe("parseEpub: rejections", () => {
  const chapter = { file: "c1", title: "One", body: "<p>Text.</p>" };
  const sample = (extraFiles: Record<string, string>) =>
    buildSampleBook({
      version: 3,
      toc: "nav",
      title: "T",
      author: "A",
      language: "en",
      chapters: [chapter],
      extraFiles,
    });

  it("rejects text that is not a zip", async () => {
    expect((await rejection(Buffer.from("definitely not a zip"))).code).toBe("not_epub");
  });

  it("rejects a zip without container.xml", async () => {
    expect((await rejection(await zipEpub({ "a.txt": "hi" }))).code).toBe("not_epub");
  });

  it("rejects a zip whose mimetype says something else", async () => {
    const data = await zipEpub(
      { "META-INF/container.xml": CONTAINER_XML },
      { mimetype: "application/zip" },
    );

    expect((await rejection(data)).code).toBe("not_epub");
  });

  it("rejects a container that points at a missing package document", async () => {
    const data = await zipEpub({ "META-INF/container.xml": CONTAINER_XML });

    expect((await rejection(data)).code).toBe("not_epub");
  });

  it("rejects DRM encryption.xml", async () => {
    const data = await sample({
      "META-INF/encryption.xml": encryption("http://www.w3.org/2001/04/xmlenc#aes128-cbc"),
    });

    expect((await rejection(data)).code).toBe("drm");
  });

  it("rejects rights.xml", async () => {
    const data = await sample({ "META-INF/rights.xml": "<rights/>" });

    expect((await rejection(data)).code).toBe("drm");
  });

  it("accepts font obfuscation, which is not DRM", async () => {
    const data = await sample({
      "META-INF/encryption.xml": encryption("http://www.idpf.org/2008/embedding"),
    });

    expect((await parseEpub(data)).chapters).toHaveLength(1);
  });

  it("rejects a book with no readable text", async () => {
    const data = await buildSampleBook({
      version: 3,
      toc: "nav",
      title: "T",
      author: "A",
      language: "en",
      chapters: [
        { file: "c1", title: "One", body: "<img src='a.png'/><table><tr><td>x</td></tr></table>" },
      ],
    });

    expect((await rejection(data)).code).toBe("no_chapters");
  });
});

describe("parseEpub: archive limits", () => {
  it("rejects too many entries", async () => {
    const data = await lighthouseBook();

    expect((await rejection(data, { ...DEFAULT_LIMITS, maxEntries: 3 })).code).toBe(
      "unsafe_archive",
    );
  });

  it("rejects archives that declare too much data", async () => {
    const data = await lighthouseBook();

    expect((await rejection(data, { ...DEFAULT_LIMITS, maxDeclaredBytes: 100 })).code).toBe(
      "unsafe_archive",
    );
  });

  it("stops inflating text beyond the budget", async () => {
    const big = "<p>" + "word ".repeat(200_000) + "</p>";
    const data = await zipEpub({
      "META-INF/container.xml": CONTAINER_XML,
      "OEBPS/content.opf": `<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`,
      "OEBPS/a.xhtml": xhtml(big),
    });

    expect((await rejection(data, { ...DEFAULT_LIMITS, maxTextBytes: 64 * 1024 })).code).toBe(
      "unsafe_archive",
    );
  });

  it("does not resolve external entities", async () => {
    const data = await buildSampleBook({
      version: 3,
      toc: "nav",
      title: "T",
      author: "A",
      language: "en",
      chapters: [{ file: "c1", title: "One", body: "<p>Text &xxe; here.</p>" }],
      extraFiles: {
        "OEBPS/c1.xhtml": `<?xml version="1.0"?><!DOCTYPE html [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><html><body><p>Text &xxe; here.</p></body></html>`,
      },
    });

    const text = (await parseEpub(data)).chapters[0]?.text ?? "";

    expect(text).toContain("Text");
    expect(text).not.toContain("root:");
  });
});

const withDocument = (body: string, extra: Record<string, string> = {}) =>
  zipEpub({
    "META-INF/container.xml": CONTAINER_XML,
    "OEBPS/content.opf": `<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`,
    "OEBPS/a.xhtml": xhtml(body),
    ...extra,
  });

describe("parseEpub: hostile markup", () => {
  it("rejects a document with too many nodes", async () => {
    const data = await withDocument("<i/>".repeat(1000));

    const error = await rejection(data, { ...DEFAULT_LIMITS, maxNodesPerDocument: 500 });

    expect(error.code).toBe("unsafe_archive");
  });

  it("counts nodes across all documents of a book", async () => {
    const data = await buildSampleBook({
      version: 3,
      toc: "none",
      title: "T",
      author: "A",
      language: "en",
      chapters: Array.from({ length: 20 }, (_, i) => ({
        file: `c${i}`,
        title: "x",
        body: "<p>a</p>".repeat(10),
      })),
    });

    const error = await rejection(data, { ...DEFAULT_LIMITS, maxNodesPerBook: 300 });

    expect(error.code).toBe("unsafe_archive");
  });

  it(
    "copes with a very large number of siblings and no heading",
    async () => {
      const data = await withDocument("<p/>".repeat(300_000) + "<p>text</p>");

      const book = await parseEpub(data);

      expect(book.chapters[0]?.text).toBe("text");
    },
    HEAVY_TEST_MS,
  );

  it(
    "is not slowed down by a huge run of blanks before text",
    async () => {
      const data = await withDocument(`<p>${" ".repeat(5_000_000)}[1]text</p>`);
      const started = Date.now();

      const book = await parseEpub(data);

      expect(book.chapters[0]?.text).toBe("text");
      // A quadratic scan of 5 million blanks would take minutes; this only has to stay far below that.
      expect(Date.now() - started).toBeLessThan(10_000);
    },
    HEAVY_TEST_MS,
  );

  it("rejects a single document over the per-document byte cap", async () => {
    const data = await withDocument(`<p>${"word ".repeat(5000)}</p>`);

    const error = await rejection(data, { ...DEFAULT_LIMITS, maxDocumentBytes: 2000 });

    expect(error.code).toBe("unsafe_archive");
  });
});

const chapter = (file: string) => ({ file, title: "x", body: "<p>Text.</p>" });

describe("parseEpub: bounds on what is stored", () => {
  it("shortens very long titles and authors", async () => {
    const data = await buildSampleBook({
      version: 3,
      toc: "nav",
      title: "T".repeat(5000),
      author: "A".repeat(5000),
      language: "en",
      chapters: [chapter("c1")],
      tocEntries: [["C".repeat(5000), "c1.xhtml"]],
    });

    const book = await parseEpub(data);

    expect(book.title).toHaveLength(300);
    expect(book.title.endsWith("\u2026")).toBe(true);
    expect(book.author).toHaveLength(300);
    expect(book.chapters[0]?.title).toHaveLength(200);
  });

  it("rejects a book with more chapters than the limit", async () => {
    const data = await buildSampleBook({
      version: 3,
      toc: "none",
      title: "T",
      author: "A",
      language: "en",
      chapters: Array.from({ length: 12 }, (_, i) => chapter(`c${i}`)),
    });

    const error = await rejection(data, { ...DEFAULT_LIMITS, maxChapters: 10 });

    expect(error.code).toBe("too_many_chapters");
    expect(error.message).toContain("10");
  });
});
