# book-to-audio

Turn your own e-books into audiobooks. Upload an EPUB (later also PDF), pick the language, and the app reads every chapter aloud with a text-to-speech engine. You can play each chapter in the browser as soon as it is ready, and download the whole book as an M4B audiobook or as a ZIP of WebM chapter files. See the [application spec](docs/spec.md).

## Run with Docker

```bash
docker compose up --build
```

Open http://127.0.0.1:3000. The app is published on localhost only. Set `BOOK_TO_AUDIO_PORT` to use another host port. The app has no authentication, so keep the `127.0.0.1:` prefix if you change the port mapping or run the image with `docker run -p`.

Books, audio and the SQLite database live in the `book-data` volume (`/data` in the container), so they survive restarts and rebuilds. `docker compose down -v` deletes them.

## Develop

Requires Node.js 24 and pnpm (`corepack enable`).

```bash
pnpm install
pnpm dev
```

The dev server listens on `127.0.0.1:3000` and stores data in `./data`. Piper and ffmpeg are not installed on most dev machines, so develop with the fake engine, which needs no binaries (chapters then fail at the encoding step unless ffmpeg is on your PATH):

```bash
TTS_ENGINE=fake FAKE_TTS_DELAY_MS=1500 pnpm dev
```

Settings come from environment variables:

| Variable             | Default               | Meaning                                                                                        |
| -------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `HOST`               | `127.0.0.1`           | Address to listen on                                                                           |
| `PORT`               | `3000`                | Port to listen on                                                                              |
| `DATA_DIR`           | `./data`              | Books, audio and `app.db`                                                                      |
| `NODE_ENV`           | —                     | `development` (set by `pnpm dev`) runs Next.js in dev mode; anything else serves the built app |
| `MAX_UPLOAD_MB`      | `200`                 | Largest accepted upload                                                                        |
| `TTS_ENGINE`         | `piper`               | `piper` or `fake` (a tone, for development and tests)                                          |
| `PIPER_BIN`          | `piper`               | Piper executable                                                                               |
| `PIPER_VOICES_DIR`   | `/opt/piper-voices`   | Directory with Piper `.onnx` voices and their `.onnx.json` files (set in the Docker image)      |
| `FFMPEG_BIN`         | `ffmpeg`              | ffmpeg executable                                                                              |
| `FFPROBE_BIN`        | `ffprobe`             | ffprobe executable (measures chapter files before the M4B is built)                            |
| `OPUS_BITRATE`       | `32k`                 | Bitrate of the chapter WebM/Opus files                                                         |
| `M4B_BITRATE`        | `64k`                 | AAC bitrate of the M4B audiobook (mono)                                                        |
| `ALLOWED_HOSTS`      | —                     | Extra host names the app answers to, comma separated. `localhost`, `127.0.0.1` and `[::1]` always work |
| `WORKERS`            | half the CPU cores    | Default number of chapters converted at the same time (at least 1). A value saved on the Settings page wins |
| `MIN_FREE_DISK_MB`   | `500`                 | Conversion pauses (banner, Resume) when less than this is free on the disk that holds `DATA_DIR` |
| `FAKE_TTS_DELAY_MS`  | `0`                   | Delay per chunk for the fake engine, to watch progress in the UI                               |
| `FAKE_TTS_FAIL_MARKER` | —                   | Fake engine, dev only: any chunk whose text contains this always fails (a chapter fails after 4 attempts) |
| `FAKE_TTS_BAD_MARKER` | —                    | Fake engine, dev only: any chunk whose text contains this always fails like unreadable text, which does not count towards pausing the pool |
| `FAKE_TTS_FLAKY_MARKER` | —                  | Fake engine, dev only: any chunk whose text contains this fails its first 2 attempts, then succeeds |

Conversion runs on a pool of workers (Settings page, or `GET`/`PATCH /api/settings`). Each worker keeps one Piper process (`PIPER_BIN` must be the Piper binary or a script that `exec`s it; its process group is killed on timeout), and progress is saved per chunk: each chunk is encoded to Opus as soon as it is read and kept in `audio/<book>/<NN>.parts/`, so after a restart a chapter continues from its last finished chunk, and the chapter file is made by joining the chunks without re-encoding. Chunks are only reused when the engine, voice, sample rate and chunk count are unchanged. A failed chunk is retried three times; three chapters failing in a row (text that cannot be read does not count) pause the pool until it is resumed, and so does a nearly full disk (`POST /api/pool/resume`, or the banner in the app). Live updates come from `GET /api/events` (server-sent events). To try the failure handling, run the fake engine with markers and put the marker text in a chapter:

```bash
TTS_ENGINE=fake FAKE_TTS_FAIL_MARKER='[fail]' FAKE_TTS_FLAKY_MARKER='[flaky]' pnpm dev
```

When every chapter of a book is done, the app builds two downloads in the background, one book at a time and at a low CPU priority (`nice`): an M4B (mono AAC, chapter markers, title, author, album and the cover as an attached picture) and a ZIP of the chapter WebM files (`01 - Chapter title.webm`, stored not compressed, tagged with title, artist, album and track number, no cover). They live in `outputs/<book>/` and are offered only while they were built from the book's current audio: regenerating a chapter withdraws them at once ("Updating downloads…") and they are rebuilt when the book is done again. A book that finished with failed chapters gets none. `GET /api/books/:id/downloads/m4b` and `/zip` serve them (409 until current, Range supported); `POST /api/books/:id/outputs/rebuild` retries a failed build. A build that fails (a chapter file missing or cut short, a full disk) shows its error with a Retry button.

Requests whose `Host` header is not a local name get 403 (this stops DNS rebinding), and so do POST/PATCH requests that come from another origin. Set `ALLOWED_HOSTS` if you open the app by another name, for example `ALLOWED_HOSTS=books.lan`.

The Docker image ships the `en_US-lessac-medium` voice, so only English books can be converted for now.

Sample books for trying the app are in `fixtures/` (regenerate them with `pnpm tsx scripts/make-fixtures.ts`).

Checks:

```bash
pnpm lint          # oxlint
pnpm format        # oxfmt (pnpm format:check to verify only)
pnpm typecheck
pnpm test          # vitest
pnpm check         # all of the above
```

The same checks run in the container with `docker compose run --rm check`.

## Layout

- `src/server`: Fastify server, config and SQLite (`db/migrations.ts` holds the schema migrations).
  - `epub/`: EPUB parser ([why in-house](docs/decisions/epub-parser.md)).
  - `tts/`: engine interface, Piper and fake engines, text chunking.
  - `audio/`: ffmpeg wrapper. `outputs/`: the M4B and ZIP builder (ffmpeg commands, ffmetadata escaping, file names, ZIP writer, build queue). `convert/`: chapter conversion, chunk store and the worker pool.
  - `events/`: in-process event bus behind `GET /api/events`. `settings/`: owner settings.
  - `books/`: storage paths, repository and chapter queue. `routes/`: HTTP API under `/api`.
- `src/app`: Next.js App Router pages (library, preview, book page, settings).
- `fixtures/`: small generated EPUBs. `scripts/`: fixture generator.
