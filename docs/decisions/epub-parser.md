# Decision: EPUB parser

Status: accepted (ANO-8, slice 1) · Decision: **in-house parser** on `jszip` and `htmlparser2`.

The application spec says to try an EPUB library first and fall back to an in-house parser if it falls short. Two Node-compatible candidates were tried on generated fixtures (EPUB 3 with nav and cover, EPUB 2 with NCX and `<meta name="cover">`, one file split by fragments, spine only, DRM, not a zip, a 600 MB zip bomb). `epubjs` was not tried: it is browser oriented.

| Check                                | `epub2` 3.0.2 (last release 2023-09)          | `@lingo-reader/epub-parser` 0.4.6 (2026-04)               |
| ------------------------------------ | --------------------------------------------- | --------------------------------------------------------- |
| Title, author, language              | ok                                            | ok                                                        |
| EPUB 2 NCX table of contents         | ok                                            | ok, hrefs come back prefixed with `epub:`                 |
| EPUB 3 nav table of contents         | empty (NCX only)                              | empty on the nav fixtures                                 |
| Cover                                | found for EPUB 2 only, as a manifest id       | not found on either fixture                               |
| Fragment targets (`file.xhtml#id`)   | not supported, no way to split a file         | not supported, `href`s are rewritten and lose the anchor  |
| Text                                 | raw HTML, we would still need our own cleaner | HTML with rewritten links, same                           |
| DRM                                  | opens the encrypted book without complaint    | throws "encrypted with AES", not a typed error            |
| Not a zip                            | rejects with a message                        | unhandled rejection that crashed the Node process         |
| Zip bomb guard (entries, size)       | none, unpacks with `adm-zip` into memory      | none, `jszip` into memory                                 |

Neither library covers what the slice needs: EPUB 3 nav, splitting at anchors, a TOC that spans several spine files, typed DRM and corrupt-file errors, and limits on what is unpacked. The text extraction rules (footnotes, tables, images, `[12]` markers) would have to be written on top of their HTML output anyway, so a library would add a layer without removing the parts that are hard.

## What the in-house parser is

`src/server/epub/`, about 1,000 lines with no native code:

- `jszip` opens the archive. The central directory is walked before JSZip loads it, to cap the entry count (JSZip builds an object per entry). Declared sizes are checked up front, and every read is metered while inflating, with a cap per document as well as for the whole book, because declared sizes can lie. Entry names are only map keys, never file paths.
- The parse tree is counted while it is built (500,000 nodes per document, 5,000,000 per book), so a few kilobytes of repeated `<i/>` cannot become gigabytes of objects.
- Parsing runs in a `worker_threads` worker with a 512 MB heap cap and a two minute limit, one book at a time. A file that overruns ends the worker, not the server, and is answered with 422. The worker reads the stored upload itself, so the server never holds the whole file in memory.
- Titles are shortened (300 characters for the book, 200 for chapters) and a book may have at most 2,000 chapters.
- `htmlparser2` tokenises OPF, NCX, nav and content documents into a small tree. It decodes only built-in and numeric entities and ignores DOCTYPE, so external entities (XXE) are never resolved.
- Chapters come from the nav, else the NCX, else the spine. Each entry resolves to a (document, paragraph) position, and a chapter runs to the next entry, across spine files. Fragments resolve through the anchors found during extraction.

## Known limits

- Text before the first TOC entry (cover page, title page) is not converted. Content the TOC does not list but that sits between two entries is merged into the earlier chapter.
- `htmlparser2` is tolerant, not a validating XML parser. Broken XHTML yields text rather than an error.
- Only `jszip` and `htmlparser2` are new runtime dependencies for parsing.
