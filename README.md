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
| `OPUS_BITRATE`       | `32k`                 | Bitrate of the chapter WebM/Opus files                                                         |
| `ALLOWED_HOSTS`      | —                     | Extra host names the app answers to, comma separated. `localhost`, `127.0.0.1` and `[::1]` always work |
| `FAKE_TTS_DELAY_MS`  | `0`                   | Delay per chunk for the fake engine, to watch progress in the UI                               |

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
  - `audio/`: ffmpeg wrapper. `convert/`: chapter conversion and the scheduler.
  - `books/`: storage paths, repository and chapter queue. `routes/`: HTTP API under `/api`.
- `src/app`: Next.js App Router pages (library, preview, book page).
- `fixtures/`: small generated EPUBs. `scripts/`: fixture generator.
