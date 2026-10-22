// Regenerates the sample EPUBs in fixtures/: pnpm tsx scripts/make-fixtures.ts
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { lighthouseBook, rainBook } from "../src/server/epub/testing/sample-books.js";
import {
  germanBook,
  russianBook,
  ukrainianBook,
} from "../src/server/epub/testing/sample-books-languages.js";

const outDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(`${outDir}lighthouse-keepers-almanac.epub`, await lighthouseBook());
await fs.writeFile(`${outDir}field-notes-on-rain.epub`, await rainBook());
await fs.writeFile(`${outDir}zapovit-ta-inshi-storinky.epub`, await ukrainianBook());
await fs.writeFile(`${outDir}chekhov-rasskazy.epub`, await russianBook());
await fs.writeFile(`${outDir}der-froschkoenig.epub`, await germanBook());
console.log(`wrote fixtures to ${outDir}`);
