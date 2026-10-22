import { CONTAINER_XML, xhtml, zipEpub, type FileMap } from "./build-epub.js";
import { makeCover } from "./png.js";

export interface SampleChapter {
  /** File name under OEBPS/, without extension. */
  file: string;
  title: string;
  /** Inner HTML of `<body>`. */
  body: string;
}

export interface SampleBook {
  version: 2 | 3;
  title: string;
  author: string;
  language: string | null;
  chapters: SampleChapter[];
  /** Which table of contents to write. `none` leaves only the spine. */
  toc: "nav" | "ncx" | "none";
  /** TOC targets, as `[label, href]`. Defaults to one entry per chapter file. */
  tocEntries?: [string, string][];
  cover?: Buffer | null;
  extraFiles?: FileMap;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Builds an EPUB from a description. Used by tests and by `scripts/make-fixtures.ts`. */
export function buildSampleBook(book: SampleBook): Promise<Buffer> {
  const entries = book.tocEntries ?? book.chapters.map((c) => [c.title, `${c.file}.xhtml`]);
  const files: FileMap = { "META-INF/container.xml": CONTAINER_XML };

  const manifest = book.chapters.map(
    (c) => `<item id="${c.file}" href="${c.file}.xhtml" media-type="application/xhtml+xml"/>`,
  );
  const spine = book.chapters.map((c) => `<itemref idref="${c.file}"/>`);

  let meta = "";
  if (book.cover) {
    files["OEBPS/images/cover.png"] = book.cover;
    manifest.push(
      `<item id="cover-img" href="images/cover.png" media-type="image/png"${book.version === 3 ? ' properties="cover-image"' : ""}/>`,
    );
    if (book.version === 2) meta = `<meta name="cover" content="cover-img"/>`;
  }
  if (book.toc === "nav") {
    manifest.push(
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    );
    const items = entries.map(([label, href]) => `<li><a href="${href}">${esc(label)}</a></li>`);
    files["OEBPS/nav.xhtml"] = xhtml(
      `<nav epub:type="toc"><h1>Contents</h1><ol>${items.join("")}</ol></nav>`,
    );
  }
  let spineAttrs = "";
  if (book.toc === "ncx") {
    manifest.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
    spineAttrs = ' toc="ncx"';
    const points = entries.map(
      ([label, href], i) =>
        `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${esc(label)}</text></navLabel>` +
        `<content src="${href}"/></navPoint>`,
    );
    files["OEBPS/toc.ncx"] =
      `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">` +
      `<head/><docTitle><text>${esc(book.title)}</text></docTitle><navMap>${points.join("")}</navMap></ncx>`;
  }

  const language = book.language ? `<dc:language>${book.language}</dc:language>` : "";
  files["OEBPS/content.opf"] =
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="${book.version}.0" unique-identifier="id">` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:sample</dc:identifier>` +
    `<dc:title>${esc(book.title)}</dc:title><dc:creator>${esc(book.author)}</dc:creator>${language}${meta}</metadata>` +
    `<manifest>${manifest.join("")}</manifest><spine${spineAttrs}>${spine.join("")}</spine></package>`;

  for (const c of book.chapters) files[`OEBPS/${c.file}.xhtml`] = xhtml(c.body, c.title);
  // Extra files win, so a test can replace any generated file.
  return zipEpub({ ...files, ...book.extraFiles });
}

const paragraphs = (...texts: string[]) => texts.map((t) => `<p>${t}</p>`).join("\n");

/** EPUB 3 with a nav document, a cover, a footnote and an image. */
export function lighthouseBook(): Promise<Buffer> {
  return buildSampleBook({
    version: 3,
    toc: "nav",
    title: "The Lighthouse Keeper's Almanac",
    author: "Mira Halvorsen",
    language: "en",
    cover: makeCover([32, 52, 64], [226, 188, 120]),
    chapters: [
      {
        file: "ch1",
        title: "The Last Boat",
        body:
          `<h1>The Last Boat</h1>` +
          paragraphs(
            "The supply boat left the harbour at dawn, and by noon the island was only a grey smudge behind it.",
            `Ansel stood on the jetty with his two crates and watched it go.<a epub:type="noteref" href="notes.xhtml#n1">1</a> Nobody had told him how quiet an island could be.`,
            "He climbed the hundred and twelve steps to the lamp room and set down his bag. The glass was streaked with salt, and the brass had gone green at the edges. There was work to do before dark.",
          ) +
          `<img src="images/cover.png" alt="decorative"/>`,
      },
      {
        file: "ch2",
        title: "A Ledger of Weather",
        body:
          `<h1>A Ledger of Weather</h1>` +
          paragraphs(
            "Every morning he wrote down the wind, the cloud, and the colour of the sea. The ledger had forty years of entries, in six different hands.",
            "Some keepers wrote in careful sentences. Others left only numbers. One had drawn a tiny sun beside every clear day, and Ansel found that he was looking for those little suns.",
            "By the end of the first week he had added his own, a small and slightly crooked circle.",
          ),
      },
      {
        file: "ch3",
        title: "The Fog Signal",
        body:
          `<h1>The Fog Signal</h1>` +
          paragraphs(
            "On the ninth night the fog came in so thick that the beam of the lamp seemed to stop an arm's length from the glass.",
            "He started the horn. It gave one long note every thirty seconds, and between the notes the silence was enormous.",
            "Somewhere out in the white, a ship answered with a bell. Ansel counted forty answers before the sky began to lighten.",
          ),
      },
      {
        file: "ch4",
        title: "What the Tide Left",
        body:
          `<h1>What the Tide Left</h1>` +
          paragraphs(
            "In the morning the beach was covered with small treasures: a blue glass float, a length of rope, a wooden box with a broken latch.",
            "Inside the box was a single letter, folded twice and still dry. It was addressed to the keeper of the light, whoever that might be.",
            "He read it standing in the wind, and then he went back up the steps to write the day's weather in the ledger.",
          ),
      },
      {
        file: "notes",
        title: "Notes",
        body: `<aside epub:type="footnote" id="n1"><p>1. The boat came every second Thursday.</p></aside>`,
      },
    ],
    // The notes page is in the spine, but is not a chapter.
    tocEntries: [
      ["The Last Boat", "ch1.xhtml"],
      ["A Ledger of Weather", "ch2.xhtml"],
      ["The Fog Signal", "ch3.xhtml"],
      ["What the Tide Left", "ch4.xhtml"],
    ],
  });
}

/** EPUB 2 with an NCX table of contents and a cover declared through `<meta name="cover">`. */
export function rainBook(): Promise<Buffer> {
  return buildSampleBook({
    version: 2,
    toc: "ncx",
    title: "Field Notes on Rain",
    author: "Tomas Wren",
    language: "en-GB",
    cover: makeCover([78, 56, 48], [214, 196, 160]),
    chapters: [
      {
        file: "rain1",
        title: "Drizzle",
        body:
          `<h2>Drizzle</h2>` +
          paragraphs(
            "Drizzle is rain that cannot be bothered to fall properly. It hangs about the lane and settles on your sleeves.",
            "I have walked through it for an hour and arrived wetter than a storm would have left me, and in a better mood.",
          ),
      },
      {
        file: "rain2",
        title: "Downpour",
        body:
          `<h2>Downpour</h2>` +
          paragraphs(
            "A downpour has no patience for subtlety. The gutters sing, the street turns into a shallow river, and everyone under the bus shelter becomes briefly friendly.",
            "Afterwards the air smells of stone and earth. There is a word for that smell, and I always forget it.",
          ),
      },
      {
        file: "rain3",
        title: "After the Rain",
        body:
          `<h2>After the Rain</h2>` +
          paragraphs(
            "The best rain is the one that has just stopped. Every leaf holds a bead of water, and the light comes in low and gold.",
            "I stand at the window with a cup of tea and watch the street dry, one patch of pavement at a time.",
          ),
      },
    ],
  });
}
