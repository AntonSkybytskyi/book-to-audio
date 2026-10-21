// Regenerates the sample EPUBs in fixtures/: pnpm tsx scripts/make-fixtures.ts
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { lighthouseBook, rainBook } from "../src/server/epub/testing/sample-books.js";

const outDir = fileURLToPath(new URL("../fixtures/", import.meta.url));

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(`${outDir}lighthouse-keepers-almanac.epub`, await lighthouseBook());
await fs.writeFile(`${outDir}field-notes-on-rain.epub`, await rainBook());
console.log(`wrote fixtures to ${outDir}`);
