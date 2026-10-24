# Decision: TTS runs in services behind one HTTP API

Status: accepted (ANO-16) · Decision: core reaches text-to-speech only through **TTS services**, each answering the same three endpoints described in [`packages/contracts/openapi/tts-service.yaml`](../../packages/contracts/openapi/tts-service.yaml). Piper moved out of core's image into its own service, `apps/piper-api`.

Before, core ran Piper itself, with the binary and every voice model in its image. A better voice for one language meant changing core's image and code, and every model made the image bigger. Now a service can be added, replaced or given more voices without touching core.

## The API

- `GET /health`: 200 when the service can read text aloud, 503 with a reason when not (piper-api: no voices, or no Piper binary). Docker gates core on it.
- `GET /voices`: the voices (`id`, `language`, `name`, `sampleRate`, optional `speaker`), the service's preferred ones first, plus `maxInputChars` (longest text per request) and `concurrency` (requests it reads at once).
- `POST /synthesize` with `{ voice, text }`: a 16-bit mono WAV. WAV rather than raw PCM because the sample rate travels with the audio and any engine can write it.
- Errors are `{ code, message, detail? }` with one status per code: `voice_not_found` 404, `bad_input` 422, `synthesis_failed` 500, `engine_unavailable` 503, `timeout` 504. `message` can be shown to the user; `detail` is for the logs. `bad_input` (this text cannot be read) stays apart from the rest: it is not retried and does not count towards pausing the service. A 503 without this body (`{ status: "stopping" }` from a service that is shutting down, or a proxy's bare 502, 503 or 504) means the service went away: the chapter waits for it instead of failing.
- A client that hangs up cancels the work.

The types are in `@book-to-audio/contracts` (`tts-service.ts`), hand-written; a test checks them against the OpenAPI file.

## In core

- `TTS_SERVICES=name=url,...` lists the services. Each is an `HttpTtsEngine` behind the existing `TtsEngine` interface; a `TtsCatalog` holds them in that order. The service returns bare voice ids and core puts the service name in front (`piper:en_US-lessac-medium`), so two services cannot clash.
- The catalog asks every service for its voices before core listens (5 s at most each), then every 30 s, or every 5 s while one does not answer. A service that stops answering keeps the voices it listed, so the chapters waiting for them resume when it is back.
- A language is read by the voice chosen on the Settings page, else the first voice for it, services in order. A chosen voice on a service that has not answered yet is waited for rather than replaced, so a restart does not change the voice of a book.
- The HTTP client uses `node:http` with a keep-alive agent. A request has one deadline (10 min by default, `TTS_REQUEST_TIMEOUT_MS`) that covers the service's queue, can be cancelled, and is tried again (after 250 ms and 1 s) only when it never got an answer: refused, reset or unreachable. When that keeps failing the error is `unreachable`, a code of core's own.
- Chapters are split per service: `maxCharsFor(language)` is the limit of the service that reads the language.

## The pool

- A group of workers per service: `workers.<service>` from the Settings page, else the service's `concurrency`, and 0 while it does not answer. A worker only claims chapters whose language is read by its service (`ChapterQueue.claimNext(languages)`), still earliest book first.
- Three failed chapters in a row pause **that service** (`service_state`); the others carry on. A full disk still pauses everything (`pool_state`).
- `unreachable` puts the chapter back in the queue without failing it, and the service gets no workers until it answers. A chapter that finds its service gone three times in a row fails instead, and that failure counts towards pausing the service, so a text that knocks the service over does not loop forever. `voice_not_found` fails the chapter but does not count towards the pause; it makes core ask the service for its voices again.
- When a language's voice moves to another service, chapters already running keep their voice; the next one goes to the other service's workers.

## piper-api

- At most `PIPER_CONCURRENCY` texts are read at once (default half the cores); more wait first come first served, and a client that hangs up leaves the queue. That number is also the most Piper processes alive, across all voices: a process stays warm for its voice and is reused for the next text, and a new voice closes the one idle longest. So `concurrency` is what the service really does, and memory stays bounded.
- Everything Piper-specific from before stays: the startup grace on the first text of a process, the process group killed on a timeout or cancel, a private scratch folder, one `speaker_id` per multi-speaker model.
- In `pnpm dev` and its tests it runs `dev/fake-piper.mjs`, a stand-in that speaks Piper's `--json-input` protocol, with stand-in voices for the three languages. Nothing needs Piper installed.

## Old data

Benchmark results and learned speeds were keyed by the old engine id and bare voice ids, so migration 11 deletes them and the single worker count; the speed test runs again at the next start. Chunks of a chapter that was half done no longer match (`meta.json` records the service and voice), so such a chapter is read again from the start.

## Known gaps

- The acceptance run with real Piper is `docker compose up`; CI builds the images but does not run a book through them.
- `pnpm benchmark` uses each language's default voice, not one chosen on the Settings page.
- A multi-speaker model still offers only its default speaker.
