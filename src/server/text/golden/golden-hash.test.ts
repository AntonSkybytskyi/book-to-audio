import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEpub } from "../../epub/parse.js";
import { lighthouseBook } from "../../epub/testing/sample-books.js";
import { russianBook, ukrainianBook } from "../../epub/testing/sample-books-languages.js";
import { prepareForSpeech, TEXT_PROCESSING_VERSION } from "../index.js";
import { EN_GOLDEN } from "./en.js";
import { RU_GOLDEN } from "./ru.js";
import { UK_GOLDEN } from "./uk.js";

/**
 * The version of the text rules, and a hash of what they produce for the golden inputs and the
 * sample books. This only notices that the output for this corpus changed: it cannot tell a rule
 * change that matters from one that does not, and it does not raise the version by itself. When
 * it fails, first check `golden.test.ts` and read what changed; if listeners would hear another
 * text, raise `TEXT_PROCESSING_VERSION` by hand (chunks made under the old rules are then thrown
 * away on resume) and record the new version and hash here. The hash can also move for reasons
 * outside the rules (the Node or ICU version, the EPUB parser changing the sample books' text),
 * and then only this hash is updated.
 */
const EXPECTED = { version: 3, hash: "4a782117481af4af" };

const chapters = async (book: Promise<Buffer>) =>
  (await parseEpub(await book)).chapters.map((chapter) => chapter.text);

describe("the text rules' version", () => {
  it("has the recorded version and the recorded hash of the output for the corpus", async () => {
    const corpus: [string, string][] = [
      ...EN_GOLDEN.flatMap((g) => g.cases.map(([input]) => ["en", input] as [string, string])),
      ...RU_GOLDEN.flatMap((g) => g.cases.map(([input]) => ["ru", input] as [string, string])),
      ...UK_GOLDEN.flatMap((g) => g.cases.map(([input]) => ["uk", input] as [string, string])),
      ...(await chapters(lighthouseBook())).map((text) => ["en", text] as [string, string]),
      ...(await chapters(russianBook())).map((text) => ["ru", text] as [string, string]),
      ...(await chapters(ukrainianBook())).map((text) => ["uk", text] as [string, string]),
    ];
    const hash = createHash("sha256")
      .update(JSON.stringify(corpus.map(([language, text]) => prepareForSpeech(text, language))))
      .digest("hex")
      .slice(0, 16);

    expect({ version: TEXT_PROCESSING_VERSION, hash }).toEqual(EXPECTED);
  }, 30_000);
});
