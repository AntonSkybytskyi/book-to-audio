# book-to-audio

Turn your own e-books into audiobooks. Upload an EPUB (later also PDF), pick the language, and the app reads every chapter aloud with a text-to-speech engine. You can play each chapter in the browser as soon as it is ready, and download the whole book as an M4B audiobook or as a ZIP of WebM chapter files. See the [application spec](docs/spec.md).

## Run with Docker

```bash
docker compose up --build
```

Open http://127.0.0.1:3000. The app is published on localhost only. Set `BOOK_TO_AUDIO_PORT` to use another host port. The app has no authentication, so keep the `127.0.0.1:` prefix if you change the port mapping.

Four containers run:

- `nginx` (from `apps/edge`): the only published port. It sends `/api` to `core` and everything else to `web`, so the browser sees one origin.
- `web` (from `apps/web`): the pages. They load all their data in the browser, through nginx.
- `core` (from `apps/api`): the API, the conversion pool, the downloads, the live updates and SQLite. Restarting `web` (`docker compose restart web`) does not interrupt a conversion. It starts once `piper-api` is healthy.
- `piper-api` (from `apps/piper-api`): a TTS service that reads text aloud with Piper and the voices in its image. `core` calls it over HTTP; it is not published and keeps no data.

Books, audio and the SQLite database live in the `book-data` volume (`/data` in the `core` container), so they survive restarts and rebuilds. `docker compose down -v` deletes them.

## Develop

Requires Node.js 24, pnpm (`corepack enable`) and Docker.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts core on `127.0.0.1:3002`, the Next.js dev server on `127.0.0.1:3001` and piper-api on `127.0.0.1:3003`, all reloading on changes, and the same nginx image as production in Docker in front of web and core. Open http://127.0.0.1:3000, as in production. Data is stored in `./data`. Core restarts when a file under `apps/api/src` changes or the contracts are rebuilt; if it fails before any change (a bad setting, the port in use) or the dev nginx stops, `pnpm dev` stops with it. `WEB_PORT`, `CORE_PORT` and `PIPER_PORT` move the three dev servers. The dev nginx reaches web and core through Docker Desktop's `host.docker.internal`; on Linux, run it with `network_mode: host` and `127.0.0.1` upstreams instead. Piper is not installed on most dev machines, so in `pnpm dev` piper-api runs a stand-in (`apps/piper-api/dev/fake-piper.mjs`, with stand-in voices for English, Ukrainian and Russian in `dev/voices`) that reads every text as a tone as long as the text would take to read. ffmpeg is still needed for the chapter files (chapters fail at the encoding step without it on your PATH). To watch progress in the UI, slow the stand-in down:

```bash
FAKE_PIPER_DELAY_MS=1500 pnpm dev
```

To use real Piper in development instead, set `PIPER_BIN` and `PIPER_VOICES_DIR` for piper-api.

Settings of core come from environment variables (in Docker, set them on the `core` service; `MAX_UPLOAD_MB` also goes to `nginx`, which `docker-compose.yml` does for you):

| Variable             | Default               | Meaning                                                                                        |
| -------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `HOST`               | `127.0.0.1`           | Address to listen on                                                                           |
| `PORT`               | `3000`                | Port to listen on                                                                              |
| `DATA_DIR`           | `./data`              | Books, audio and `app.db`                                                                      |
| `MAX_UPLOAD_MB`      | `200`                 | Largest accepted upload. nginx takes 1 MB more, so core's own limit answers first             |
| `TTS_SERVICES`       | — (required)          | The TTS services as `name=url`, comma separated, for example `piper=http://piper-api:5000`. A path in the url is kept (`http://host/tts` asks `http://host/tts/voices`). Set in `docker-compose.yml` and by `pnpm dev` |
| `TTS_REQUEST_TIMEOUT_MS` | `600000`          | Longest wait for one piece of text from a TTS service, its queue included                      |
| `FFMPEG_BIN`         | `ffmpeg`              | ffmpeg executable                                                                              |
| `FFPROBE_BIN`        | `ffprobe`             | ffprobe executable (measures chapter files before the M4B is built)                            |
| `OPUS_BITRATE`       | `32k`                 | Bitrate of the chapter WebM/Opus files                                                         |
| `M4B_BITRATE`        | `64k`                 | AAC bitrate of the M4B audiobook (mono)                                                        |
| `ALLOWED_HOSTS`      | —                     | Extra host names the app answers to, comma separated. `localhost`, `127.0.0.1` and `[::1]` always work |
| `MIN_FREE_DISK_MB`   | `500`                 | Conversion pauses (banner, Resume) when less than this is free on the disk that holds `DATA_DIR` |

Settings of piper-api (set them on the `piper-api` service). `PIPER_MEM_LIMIT` (default `6g`) is the memory limit of its container in `docker-compose.yml`: each Piper process holds its voice model, up to about 0.8 GB while it reads (6 processes peaked at 4.9 GB in the speed test), so by default piper-api starts no more processes than the limit holds at 1 GB each (6 at `6g`). Raise it for more processes on a machine with more than 12 cores; a `PIPER_CONCURRENCY` you set is not capped. A Piper process killed for memory shows up as "The speech engine stopped unexpectedly".

| Variable                 | Default               | Meaning                                                                                  |
| ------------------------ | --------------------- | ---------------------------------------------------------------------------------------- |
| `PORT`                   | `5000`                | Port to listen on (`HOST` as for core; `0.0.0.0` in the image)                           |
| `PIPER_CONCURRENCY`      | half the CPU cores, at most 1 per GB of memory limit | Texts read at once, at most 64, which is also the most Piper processes alive. Core runs this many workers for the service unless the Settings page says otherwise |
| `PIPER_BIN`              | `piper`               | Piper executable, or a script that `exec`s it; its process group is killed on a timeout  |
| `PIPER_VOICES_DIR`       | `/opt/piper-voices`   | Directory with Piper `.onnx` voices and their `.onnx.json` files (set in the image)      |
| `PIPER_TIMEOUT_MS`       | `120000`              | Longest wait for one text, not counting time in the queue                                |
| `PIPER_STARTUP_GRACE_MS` | `60000`               | Extra time for the first text of a process, which loads the model                        |
| `PIPER_IDLE_MS`          | `60000`               | A Piper process nobody used for this long is stopped                                     |
| `MAX_INPUT_CHARS`        | `1000`                | Longest text one request accepts; core splits chapters to fit                            |
| `SCRATCH_DIR`            | a private temp folder | Where Piper writes its WAV files (`/tmp/piper` in the image)                             |
| `FAKE_PIPER_DELAY_MS`    | `0`                   | Stand-in only (`pnpm dev`): delay per text, to watch progress in the UI                  |
| `FAKE_PIPER_FAIL_MARKER` | —                     | Stand-in only: any text that contains this fails (a chapter fails after 4 attempts)      |
| `FAKE_PIPER_BAD_MARKER`  | —                     | Stand-in only: any text that contains this fails like unreadable text, which does not count towards pausing |
| `FAKE_PIPER_FLAKY_MARKER` | —                    | Stand-in only: any text that contains this fails its first 2 attempts, then is read      |

Conversion runs on a pool of workers, a group per TTS service: as many as the service says it reads at once, or the number set for it on the Settings page (`GET`/`PATCH /api/settings`). Each worker takes only chapters whose language is read by a voice on its service, and progress is saved per chunk: each chunk is encoded to Opus as soon as it is read and kept in `audio/<book>/<NN>.parts/`, so after a restart a chapter continues from its last finished chunk, and the chapter file is made by joining the chunks without re-encoding. Chunks are only reused when the service, voice, speaker, sample rate, chunk count and version of the text rules are unchanged. A failed chunk is retried three times; three chapters of one service failing in a row (text that cannot be read does not count) pause that service's workers until it is resumed, while the other services carry on. A nearly full disk pauses everything (`POST /api/pool/resume`, with `{"service": "piper"}` for one service, or the banners in the app). A service that does not answer gets no workers: its chapters go back to the queue and carry on once it answers again. Live updates come from `GET /api/events` (server-sent events). To try the failure handling, run the stand-in with markers and put the marker text in a chapter:

```bash
FAKE_PIPER_FAIL_MARKER='[fail]' FAKE_PIPER_FLAKY_MARKER='[flaky]' pnpm dev
```

When every chapter of a book is done, the app builds two downloads in the background, one book at a time and at a low CPU priority (`nice`): an M4B (mono AAC, chapter markers, title, author, album and the cover as an attached picture) and a ZIP of the chapter WebM files (`01 - Chapter title.webm`, stored not compressed, tagged with title, artist, album and track number, no cover). They live in `outputs/<book>/` and are offered only while they were built from the book's current audio: regenerating a chapter withdraws them at once ("Updating downloads…") and they are rebuilt when the book is done again. A book that finished with failed chapters gets none. `GET /api/books/:id/downloads/m4b` and `/zip` serve them (409 until current, Range supported); `POST /api/books/:id/outputs/rebuild` retries a failed build. A build that fails (a chapter file missing or cut short, a full disk) shows its error with a Retry button.

Requests whose `Host` header is not a local name get 403 (this stops DNS rebinding), and so do POST/PATCH requests that come from another origin. Set `ALLOWED_HOSTS` if you open the app by another name, for example `ALLOWED_HOSTS=books.lan`.

The piper-api image ships one voice per language: `en_US-lessac-medium`, `uk_UA-ukrainian_tts-medium` (speaker `lada`) and `ru_RU-ruslan-medium` ([why](docs/decisions/voices.md)). Voice ids in the app start with the service's name, for example `piper:uk_UA-ukrainian_tts-medium:lada`. A language is read by the voice chosen for it on the Settings page, else by the first voice for it, services in `TTS_SERVICES` order. The language of a book is detected from its text when it is uploaded and can be changed on the preview page; the Settings page chooses which languages that list offers (English and Ukrainian by default, Russian hidden). Before a chapter is read, numbers, years, Roman numerals and common abbreviations are written out where the engine would get them wrong ([what and why](docs/decisions/text-processing.md)).

How long things take: the app measures how fast the speech engine is on your machine with a short benchmark (the speech rate, the real-time factor and the throughput with several workers at once, for each voice) and uses it for the length and conversion time on the preview and for the time left on the book page and in the library. It runs once on its own the first time the app starts, while nothing is being read, and again when the machine or the text rules change; the Settings page shows the numbers and has a Run benchmark button (`GET`/`POST`/`DELETE /api/benchmark`). While it runs no new chapter starts. After each finished chapter the estimates move a little towards what really happened. `pnpm build`, then `pnpm benchmark` (in the container: `docker compose exec core node dist/benchmark/cli.js`) prints the same measurements as a table without touching the app's data; it refuses to run while the app is converting unless you pass `--force`. How it works, what the numbers mean and the proposed speed target are in [docs/decisions/benchmark.md](docs/decisions/benchmark.md).

## TTS services

Core reads text aloud only through TTS services, over a small HTTP API described in [`packages/contracts/openapi/tts-service.yaml`](packages/contracts/openapi/tts-service.yaml): `GET /health`, `GET /voices` (the voices, the longest text per request and how many requests the service reads at once) and `POST /synthesize` with `{ "voice", "text" }`, which answers with a 16-bit mono WAV, or with an error code (`voice_not_found`, `bad_input`, `synthesis_failed`, `timeout`, `engine_unavailable`). `apps/piper-api` is the first one. Core asks every service for its voices at startup and every 30 seconds (every 5 while it does not answer).

To add another TTS service:

1. Build a service that answers those three endpoints, with its own Dockerfile.
2. Add it to `docker-compose.yml`, with a healthcheck, and to core's `depends_on` if core should wait for it.
3. Add it to `TTS_SERVICES` on core, for example `TTS_SERVICES=piper=http://piper-api:5000,other=http://other-tts:8000`. The name goes in front of its voice ids, so keep it short (lowercase letters, digits, `-` and `_`).
4. Its workers start at the number it reports; change it on the Settings page if the service can take more or fewer.

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
  - `tts/`: engine interface, the HTTP client for TTS services, the catalog of services and voices, text chunking.
  - `audio/`: ffmpeg wrapper. `outputs/`: the M4B and ZIP builder (ffmpeg commands, ffmetadata escaping, file names, ZIP writer, build queue). `convert/`: chapter conversion, chunk store and the worker pool.
  - `events/`: in-process event bus behind `GET /api/events`. `settings/`: owner settings.
  - `benchmark/`: the speed benchmark (samples, measurement through engine sessions, runner, CLI). `speed/`: the speed model of each voice (benchmark, rough defaults, learning from real chapters) and the estimator behind the times in the pages.
  - `books/`: storage paths, repository and chapter queue. `routes/`: HTTP API under `/api`.
  - `scripts/`: the fixture generator.
- `apps/web`: the web UI, a Next.js app built as a standalone server. `app/` holds the routes (library, preview, book page, settings), `ui/` the layers they are built from (`shared`, `entities`, `features`).
- `apps/edge`: the nginx image and its config.
- `apps/piper-api`: the Piper TTS service. The Piper process and its protocol, the voices folder, the queue of texts and warm processes, and the HTTP API; `dev/` holds the stand-in Piper and voices.
- `packages/contracts`: the request, response and event types shared by web and core, the estimate functions both use, and the TTS service API (types and `openapi/tts-service.yaml`) shared by core and the TTS services.
- `fixtures/`: small generated EPUBs.
