# book-to-audio: application spec (v1)

Status: draft · Linear: [ANO-5](https://linear.app/anotns/issue/ANO-5/write-application-spec)

## 1. Purpose

book-to-audio turns e-books into audiobooks. You upload an EPUB or PDF in a web page, the app pulls out the text chapter by chapter, reads it aloud with a text-to-speech (TTS) engine, and gives you audio files to play in any audiobook or music player.

The goal is to listen to books that have no official audiobook edition, using your own e-book files. In v1 everything runs locally and for free; after the MVP, a paid cloud TTS engine is expected to become the main engine for better voices (section 7).

## 2. Users and deployment

- **One user, self-hosted.** The app runs on the owner's own machine. There are no accounts, sign-in, quotas or billing in v1.
- **Docker.** The whole app starts with `docker compose up` and is opened at `http://localhost:<port>`. TTS runs on the same machine's CPU (GPU support is optional, see section 11).
- The app listens on localhost by default. Exposing it to a network is the owner's choice and is not secured in v1.

## 3. Main flow

The app has three screens: **upload**, **preview** and the **book page**, plus a **library** listing all books.

1. **Upload.** Open the web app, upload an `.epub` or `.pdf` file and pick the language (pre-filled from detection). Nothing else is chosen in v1: the language's default voice is used at 1.0× speed.
2. **Preview.** The app parses the book and shows title, author, cover and the list of chapters with their length. The preview is view only: chapters cannot be excluded, renamed or rearranged, and every chapter is converted. (Later: an option to check and fix chapter splitting with a local AI model, see section 15.)
3. **Convert.** Clicking "Convert" queues the book and opens its book page.
4. **Book page.** This is where the book is listened to and managed. It shows the book (title, author, cover, overall progress and estimated time left) and one row per chapter, which is that chapter's WebM audio file. Each row shows its status:
   - *queued*, *generating* (with progress) or *done*;
   - *failed*, with the error message.

   On each row the user can:
   - **play / pause** the chapter, as soon as it is done, even while other chapters are still generating. This is the whole player in v1: one play/pause button per row, and only one chapter plays at a time;
   - **regenerate** it: synthesize that chapter again with the book's settings, for example after a glitch or a failure.

   At book level the user can pause and resume the conversion, regenerate the whole book, and download the M4B and the WebM ZIP once all chapters are done. The page can be closed at any time; conversion keeps running.
5. **Library.** Lists all books with their status and opens a book's page. Books stay until deleted.

After a chapter is regenerated, the M4B and WebM ZIP are rebuilt from the stored chapter audio.

## 4. Input

### Supported in v1

v1 is delivered in two milestones:

- **M1: EPUB.** The full pipeline (upload, parsing, TTS, M4B and WebM output, UI) is built and proven with EPUB only.
- **M2: PDF.** PDF support is added on top of the working pipeline.

Formats:

- **EPUB 2 and EPUB 3** (M1) without DRM. Chapters come from the table of contents (nav or NCX), falling back to the spine order.
- **PDF with a text layer** (M2). Chapters come from the PDF outline (bookmarks). If there is no outline, the book is split into parts of roughly equal length. Detecting chapter headings from font size is left for later.

### Not supported in v1

- **Scanned PDFs** (pages are images, no text layer). The app detects this and shows a clear error saying OCR is planned for a later version.
- **DRM-protected files.** Detected and rejected with a clear message.
- Other formats (MOBI, AZW3, FB2, DOCX, TXT) are out of scope for v1.

### Limits

- Maximum upload size: 200 MB (configurable).
- Maximum book length: no hard limit, but the estimated conversion time is shown on the preview screen.

## 5. Text processing

The text is cleaned before it is sent to TTS. None of these steps has a user setting in v1:

- remove page numbers, running headers and footers (PDF);
- join words broken by hyphens at line ends and fix line breaks inside sentences (PDF);
- images: dropped, together with their captions unless a caption is a normal paragraph (how to handle images later: [ANO-6](https://linear.app/anotns/issue/ANO-6/decide-how-to-handle-images-in-books));
- footnotes: dropped, including their markers in the text (superscript numbers, `[12]`);
- tables: skipped;
- front matter (copyright page, table of contents page, "also by this author") is converted like any other chapter in v1; skipping it using EPUB landmarks is a later improvement;
- expand common abbreviations and numbers per language where the TTS engine does not do this itself;
- split text into sentences and then into chunks small enough for the engine.

**User control over text:** none in v1. The chapter list is view only, and there is no text editing and no pronunciation dictionary in v1; a per-book pronunciation dictionary is a candidate for a later version.

**Language detection** runs on the book text and pre-selects the language. The user can always override it.

**One language and one voice per book.** Mixed-language text (for example English names or quotes in a Ukrainian book) is read by the book's voice as is. Switching voices per sentence is out of scope.

## 6. Languages

| Language | v1 | Shown by default |
|---|---|---|
| English | yes | yes |
| Ukrainian | yes | yes |
| Russian | yes |
| Other languages | later | — |

Later versions will allow any language that an installed TTS engine supports.

## 7. Speech (TTS)

### Pluggable engines

TTS sits behind an engine interface so engines can be added without changing the rest of the app. Each engine reports:

- the languages and voices it offers;
- whether it runs locally or calls a paid cloud API;
- its maximum input size per request.

And it implements one operation: synthesize a chunk of text with a given voice and speed, returning audio.

### Default engine: local

**Role of the local engine.** The local engine is mainly for building and testing the MVP: it is free, fast to iterate with and needs no API keys. After the MVP, a cloud TTS engine is expected to become the main engine for real listening, since voice quality matters more than cost for the owner.

v1 ships with one local engine that is free and works offline. It must have usable voices for English, Ukrainian and Russian. **Piper** is the proposed default, since it has voices for all three languages and runs on CPU. It runs as a separate process inside the Docker image and is called from the Node backend.

**v1 is strictly TypeScript.** The app has no services written in other languages: an engine is either a Node library (for example an ONNX model run in Node) or a prebuilt binary started as a child process. Engines that need a Python or other runtime as a separate service are not used in v1. The engine interface is designed so such a service can be added later without changing the rest of the app, and the known trade-off is that v1 voice quality, especially for Ukrainian, is limited to what Piper and similar engines offer.

Other engines (local such as Kokoro for higher-quality English, or cloud such as OpenAI, ElevenLabs, Google or Azure) are added later through the same interface. Cloud engines must show an estimated cost before a conversion starts and need an API key set in the configuration.

### Voice and speed

In v1 each language has one default voice, and speed is fixed at 1.0×. Later versions add a voice picker filtered by language, a speed setting (0.75× to 1.5×) and a voice sample button.

## 8. Output

**Chapter audio: WebM.** Each finished chapter is stored as one WebM file with Opus audio. This is the file the book page plays (section 3), and the source that the downloads below are built from. Opus gives good speech quality at small sizes and plays natively in current Chrome, Firefox and Safari.

Once all chapters are done, two downloads are available:

- **M4B:** a single audiobook file with chapter markers, title, author and cover image.
- **WebM per chapter:** a ZIP of the stored chapter WebM files, numbered in order (`01 - Chapter title.webm`), with title, author, album (book title) and track number in the WebM metadata. Cover art is only in the M4B.

Audio is encoded with ffmpeg. Default quality: mono, 32 kbps Opus for chapter WebM files and 64 kbps AAC for M4B (set in the configuration file, not in the UI).

## 9. Jobs and progress

- Uploading and parsing are independent of conversion, so new books can be uploaded and previewed while others are converting.
- Several books can be queued for conversion at once. Each queued book is split into chapter tasks, and all chapter tasks go into one global pool.
- N workers take tasks from the pool, from any book. Each worker runs its own TTS engine process. N defaults to half the CPU cores and can be changed in settings.
- Tasks are taken **FIFO by book**: chapters of the earliest queued book go first, in chapter order. When that book has no unstarted chapters left, free workers move on to the next book, so no worker sits idle.
- When all chapters of a book are done, its M4B and WebM ZIP are built.
- A book can be paused and resumed. Pausing lets running chapters finish and stops new ones from starting. Reordering the queue is not supported in v1.
- Progress is saved per chunk. If the app or container restarts, the job **resumes** from the last finished chunk instead of starting over.
- A failed chunk is retried up to 3 times. If it still fails, that chapter is marked **failed** with the error message. Other chapters of the book, and other books, keep going.
- When the remaining chapters finish, the book's status is **done with errors**. The M4B and WebM ZIP are not built until every chapter is done. Failed chapters are fixed with **regenerate** on the book page (section 3).
- If 3 chapters fail in a row (for example, the TTS engine is missing or broken), the whole pool pauses and the UI shows a banner with the error, so the queue does not fail book after book.
- There is no separate cancel. To stop for now, pause the book; to get rid of it, delete it. Deleting a book (from its page or the library) stops its running chapters and removes all its files.
- The UI gets progress updates through server-sent events (or polling as a fallback).

## 10. Storage

- Uploaded books, intermediate audio chunks and finished outputs are stored in a Docker volume.
- Job and book metadata are stored in SQLite in the same volume.
- Intermediate chunks are deleted once a chapter finishes successfully. Finished audio is kept per chapter as WebM for as long as the book is in the library, so single chapters can be regenerated and the final files rebuilt (about 15 MB per hour of audio at 32 kbps Opus).
- Deleting a book from the library deletes all its files.

## 11. Non-functional requirements

- **Speed:** no fixed target yet. M1 includes a benchmark that measures the engine's real-time factor on the owner's machine (a 90,000-word novel is about 10 hours of audio). The app uses it to show an estimated time before each conversion, and the target is set from those numbers. Optional GPU support can come later.
- **Reliability:** no lost progress on restart (section 9).
- **Privacy:** books never leave the machine unless the user picks a cloud engine.
- **Usability:** works in current Chrome, Firefox and Safari on desktop. Mobile layout is nice to have.

## 12. Tech stack

TypeScript end to end.

- **Frontend:** React + Vite.
- **Backend:** Node.js (TypeScript) HTTP API serving the frontend, uploads, jobs and downloads.
- **Workers:** a scheduler in the backend process takes chapter tasks from the global pool and runs N TTS engine processes (section 9).
- **Database:** SQLite.
- **Parsing:** an EPUB library or an in-house parser (decided in the M1 parsing ticket), and `pdfjs-dist` for PDF text and outline.
- **TTS:** Piper binary and voice models in the Docker image, called as a child process.
- **Audio:** ffmpeg for encoding, joining chunks and writing chapters and tags.
- **Packaging:** a single Docker image plus `docker-compose.yml` with a data volume.

Exact libraries are chosen during implementation.

## 13. Out of scope for v1

- Accounts, multiple users, authentication, payments.
- OCR for scanned PDFs.
- DRM removal.
- Formats other than EPUB and PDF.
- Languages other than English, Ukrainian and Russian.
- Cloud TTS engines (the interface supports them; none ship in v1).
- Editing book text or a pronunciation dictionary.
- Excluding or renaming chapters (the chapter preview is view only).
- Choosing voice, speed or output format, and voice samples.
- Reordering the conversion queue.
- Per-sentence language detection and voice switching.
- Player features beyond play/pause: auto-advance, remembered position, playback speed, skip buttons, seek bar.
- Several voices per book (for example, a different voice for dialogue).
- Mobile apps and podcast feeds.

## 14. Open questions

1. ~~Is Piper good enough, or should non-TypeScript engines be evaluated?~~ Decided: v1 stays strictly TypeScript and uses Piper; other engines come later through the engine interface (section 7).
2. ~~EPUB parsing library?~~ Moved to the M1 ticket "Upload and EPUB parsing": try a library on 3–5 real books (English and Ukrainian), fall back to an in-house parser (`jszip` plus an XML/HTML parser) if it fails.
3. ~~PDFs without an outline?~~ Decided: split into equal parts in M2; heading detection later (section 4).
4. ~~Speed target?~~ Decided: set from an M1 benchmark (section 11).
5. ~~Parallel jobs?~~ Decided: global chapter pool across books, FIFO by book, with pause (section 9).

## 15. Next steps

Once this spec is agreed, create implementation issues in the Book to audio Linear project, roughly:

**M1: EPUB**

1. Project scaffold: monorepo, Docker image, compose file, SQLite.
2. Upload and EPUB parsing with chapter preview. First task: choose an EPUB library or write an in-house parser, tested on 3–5 real books.
3. TTS engine interface and Piper engine.
4. Global chapter task pool with N workers: progress, pause, resume, delete; per-chapter regeneration.
5. Speed benchmark and time estimates.
6. Audio output: M4B and WebM ZIP.
7. Web UI: upload with language, preview, book page with per-chapter status, player and regenerate, library.
8. Language settings, including hidden Russian.

**M2: PDF**

9. PDF parsing, text-layer detection, outline chapters or equal-size parts.
10. PDF text cleanup: headers, footers, page numbers, hyphenation.

**Later: translation** (to be described separately)

A separate pipeline step that translates the book text into another language before TTS, for example an English book into Ukrainian audio. Not part of v1; it gets its own spec.

**Later: AI chapter check** (to be described separately)

On the preview screen, an option to check chapter splitting with a local AI model and rearrange chapters when the book was split incorrectly (for example, a chapter cut in two, or several chapters merged).
