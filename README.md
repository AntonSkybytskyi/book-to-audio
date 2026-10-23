# book-to-audio

Turn your own e-books into audiobooks. Upload an EPUB (later also PDF), pick the language, and the app reads every chapter aloud with a text-to-speech engine. You can play each chapter in the browser as soon as it is ready, and download the whole book as an M4B audiobook or as a ZIP of WebM chapter files. See the [application spec](docs/spec.md).

## Run with Docker

```bash
docker compose up --build
```

Open http://127.0.0.1:3000. The app is published on localhost only. Set `BOOK_TO_AUDIO_PORT` to use another host port. The app has no authentication, so keep the `127.0.0.1:` prefix if you change the port mapping.

Three containers run:

- `nginx` (from `apps/edge`): the only published port. It sends `/api` to `core` and everything else to `web`, so the browser sees one origin.
- `web` (from `apps/web`): the pages. They load all their data in the browser, through nginx.
- `core` (from `apps/api`): the API, the conversion pool, the downloads, the live updates and SQLite. Restarting `web` (`docker compose restart web`) does not interrupt a conversion.

Books, audio and the SQLite database live in the `book-data` volume (`/data` in the `core` container), so they survive restarts and rebuilds. `docker compose down -v` deletes them.

## Develop

Requires Node.js 24, pnpm (`corepack enable`) and Docker.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts core on `127.0.0.1:3002` and the Next.js dev server on `127.0.0.1:3001`, both reloading on changes, and the same nginx image as production in Docker in front of them. Open http://127.0.0.1:3000, as in production. Data is stored in `./data`. Core restarts when a file under `apps/api/src` changes or the contracts are rebuilt; if it fails before any change (a bad setting, the port in use) or the dev nginx stops, `pnpm dev` stops with it. `WEB_PORT` and `CORE_PORT` move the two dev servers. The dev nginx reaches them through Docker Desktop's `host.docker.internal`; on Linux, run it with `network_mode: host` and `127.0.0.1` upstreams instead. Piper and ffmpeg are not installed on most dev machines, so develop with the fake engine, which needs no binaries (chapters then fail at the encoding step unless ffmpeg is on your PATH):

```bash
TTS_ENGINE=fake FAKE_TTS_DELAY_MS=1500 pnpm dev
```

Settings of core come from environment variables (in Docker, set them on the `core` service; `MAX_UPLOAD_MB` also goes to `nginx`, which `docker-compose.yml` does for you):

| Variable             | Default               | Meaning                                                                                        |
| -------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `HOST`               | `127.0.0.1`           | Address to listen on                                                                           |
| `PORT`               | `3000`                | Port to listen on                                                                              |
| `DATA_DIR`           | `./data`              | Books, audio and `app.db`                                                                      |
| `MAX_UPLOAD_MB`      | `200`                 | Largest accepted upload. nginx takes 1 MB more, so core's own limit answers first             |
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

Conversion runs on a pool of workers (Settings page, or `GET`/`PATCH /api/settings`). Each worker keeps one Piper process (`PIPER_BIN` must be the Piper binary or a script that `exec`s it; its process group is killed on timeout), and progress is saved per chunk: each chunk is encoded to Opus as soon as it is read and kept in `audio/<book>/<NN>.parts/`, so after a restart a chapter continues from its last finished chunk, and the chapter file is made by joining the chunks without re-encoding. Chunks are only reused when the engine, voice, speaker, sample rate, chunk count and version of the text rules are unchanged. A failed chunk is retried three times; three chapters failing in a row (text that cannot be read does not count) pause the pool until it is resumed, and so does a nearly full disk (`POST /api/pool/resume`, or the banner in the app). Live updates come from `GET /api/events` (server-sent events). To try the failure handling, run the fake engine with markers and put the marker text in a chapter:

```bash
TTS_ENGINE=fake FAKE_TTS_FAIL_MARKER='[fail]' FAKE_TTS_FLAKY_MARKER='[flaky]' pnpm dev
```

When every chapter of a book is done, the app builds two downloads in the background, one book at a time and at a low CPU priority (`nice`): an M4B (mono AAC, chapter markers, title, author, album and the cover as an attached picture) and a ZIP of the chapter WebM files (`01 - Chapter title.webm`, stored not compressed, tagged with title, artist, album and track number, no cover). They live in `outputs/<book>/` and are offered only while they were built from the book's current audio: regenerating a chapter withdraws them at once ("Updating downloads…") and they are rebuilt when the book is done again. A book that finished with failed chapters gets none. `GET /api/books/:id/downloads/m4b` and `/zip` serve them (409 until current, Range supported); `POST /api/books/:id/outputs/rebuild` retries a failed build. A build that fails (a chapter file missing or cut short, a full disk) shows its error with a Retry button.

Requests whose `Host` header is not a local name get 403 (this stops DNS rebinding), and so do POST/PATCH requests that come from another origin. Set `ALLOWED_HOSTS` if you open the app by another name, for example `ALLOWED_HOSTS=books.lan`.

The Docker image ships one voice per language: `en_US-lessac-medium`, `uk_UA-ukrainian_tts-medium` (speaker `lada`) and `ru_RU-ruslan-medium` ([why](docs/decisions/voices.md)). The language of a book is detected from its text when it is uploaded and can be changed on the preview page; the Settings page chooses which languages that list offers (English and Ukrainian by default, Russian hidden). Before a chapter is read, numbers, years, Roman numerals and common abbreviations are written out where the engine would get them wrong ([what and why](docs/decisions/text-processing.md)).

How long things take: the app measures how fast the speech engine is on your machine with a short benchmark (the speech rate, the real-time factor and the throughput with several workers at once, for each voice) and uses it for the length and conversion time on the preview and for the time left on the book page and in the library. It runs once on its own the first time the app starts, while nothing is being read, and again when the machine or the text rules change; the Settings page shows the numbers and has a Run benchmark button (`GET`/`POST`/`DELETE /api/benchmark`). While it runs no new chapter starts. After each finished chapter the estimates move a little towards what really happened. `pnpm build`, then `pnpm benchmark` (in the container: `docker compose exec core node dist/benchmark/cli.js`) prints the same measurements as a table without touching the app's data; it refuses to run while the app is converting unless you pass `--force`. How it works, what the numbers mean and the proposed speed target are in [docs/decisions/benchmark.md](docs/decisions/benchmark.md).

Sample books for trying the app are in `fixtures/` (regenerate them with `pnpm --filter @book-to-audio/api fixtures`).

Checks:

```bash
pnpm lint          # oxlint
pnpm format        # oxfmt (pnpm format:check to verify only)
pnpm typecheck     # every package
pnpm test          # vitest, every package
pnpm check         # all of the above
```

The same checks run in the container with `docker compose run --rm check`.

CI (`.github/workflows/ci.yml`) runs lint, format check, typecheck, tests, build and a build of every Docker image (not pushed) on every pull request and every push to `main`. The code checks are steps of one `check` job and all run even when one fails; the images are built by the `docker (api)`, `docker (web)`, `docker (edge)` and `docker (piper-api)` jobs, and `edge-smoke` starts the nginx image between stub upstreams and checks its routing, headers, upload limit and answer while core is down (`apps/edge/smoke-test.sh`, also runnable locally).

Making these checks required before a PR can be merged into `main` needs a public repo or GitHub Pro. Once that is in place:

```bash
gh api -X PUT repos/AntonSkybytskyi/book-to-audio/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "check",
      "docker (api)",
      "docker (web)",
      "docker (edge)",
      "docker (piper-api)",
      "edge-smoke"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

## Layout

A pnpm workspace. `apps/` holds everything that runs on its own, each with its own Dockerfile; `packages/` holds libraries that apps import and that never run on their own. An app never imports another app, only packages (a lint rule checks this).

- `apps/api`: the core. Fastify server, config and SQLite (`src/db/migrations.ts` holds the schema migrations). It serves `/api` only.
  - `epub/`: EPUB parser ([why in-house](docs/decisions/epub-parser.md)).
  - `tts/`: engine interface, Piper and fake engines, text chunking.
  - `audio/`: ffmpeg wrapper. `outputs/`: the M4B and ZIP builder (ffmpeg commands, ffmetadata escaping, file names, ZIP writer, build queue). `convert/`: chapter conversion, chunk store and the worker pool.
  - `events/`: in-process event bus behind `GET /api/events`. `settings/`: owner settings.
  - `benchmark/`: the speed benchmark (samples, measurement through engine sessions, runner, CLI). `speed/`: the speed model of each voice (benchmark, rough defaults, learning from real chapters) and the estimator behind the times in the pages.
  - `books/`: storage paths, repository and chapter queue. `routes/`: HTTP API under `/api`.
  - `scripts/`: the fixture generator.
- `apps/web`: the web UI, a Next.js app built as a standalone server. `app/` holds the routes (library, preview, book page, settings), `ui/` the layers they are built from (`shared`, `entities`, `features`).
- `apps/edge`: the nginx image and its config.
- `packages/contracts`: the request, response and event types shared by web and core, and the estimate functions both use.
- `fixtures/`: small generated EPUBs.
