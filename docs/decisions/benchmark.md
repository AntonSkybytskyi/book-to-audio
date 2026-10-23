# Decision: speed benchmark and time estimates

Status: proposed, the speed target needs the owner's confirmation (ANO-11, slice 6) · Code: `apps/api/src/benchmark/` (measurement, runner, CLI), `apps/api/src/speed/` (the model of each voice, learning, the estimator), `packages/contracts/src/estimate.ts` (the arithmetic, used by the server and the pages), migration 8.

The spec (section 11) says there is no fixed speed target yet: M1 measures the engine's real-time factor on the owner's machine, shows an estimated time before each conversion, and the target is set from those numbers. This record is the method, the numbers measured here, and a proposed target.

## What is measured

For **each default voice** (en, uk, ru; the one voice per language the app reads books with) the benchmark reads a fixed sample through the engine's own sessions (`TtsEngine.open` / `synthesize`, the same code a conversion uses, so the fake engine works for tests and development) and records:

| Number | How | What it is for |
| --- | --- | --- |
| **Speech rate** | seconds of audio per 1,000 characters of *prepared* text (after the text rules of slice 5, split into chunks the way a chapter is) | audio length of a book from its characters |
| **Real-time factor** (RTF) | synthesis wall time / audio length, one session, **after** a warm-up line, **without** the Opus encoding | how fast the engine is alone; the number the spec asks for |
| **Opus encode cost** | encoding wall time / audio length, with the real encoder (`encodeWebm`) on every chunk | shows what the encoding adds; it is about a fifth of the synthesis time, so it is **not negligible** and is part of the throughput |
| **Throughput with N sessions** | N sessions read the sample at the same time, each chunk synthesized and then encoded as a worker does; audio seconds of all sessions / wall seconds | how the speed grows when Piper processes compete for cores (it does not grow linearly) |
| **Model load** | time of `open` plus the warm-up line | reported apart, not in any factor |

N runs from 1 up to the most workers the settings allow, capped at 4, and also the worker count in use when it is higher (so it is measured, not guessed), up to 8. Each phase reads the sample twice (`DEFAULT_REPEAT`): the engine is quick, one pass is a few seconds, and a busy moment on the machine would otherwise be the whole measurement. Every session it opens is closed, also on failure or cancel.

**The sample** (`benchmark/samples.ts`) is three scenes of plain prose written for this app (so no licence applies), the same story in English, Ukrainian and Russian: a ferry in the fog, with description, a dialogue, a year, a time of day, a count, a price and a percentage, about 1,100 characters after preparation (two chunks of the engine's 1,000-character limit, 65 s of audio). It goes through `prepareForSpeech` like a chapter, so the Ukrainian numbers are spelled out and the rate is per character of what the engine is really given. The warm-up is one short line per language.

## When it runs

1. **At startup**, once (and once more if the first run began while the 1-minute load average was above the number of cores, which is recorded with the result), when some default voice has no result for this engine, or its result is from another machine (CPU count or model) or from older text rules (`TEXT_PROCESSING_VERSION`). It waits for a moment when no chapter is being read and none is waiting (`WorkerPool.holdWhenIdle`), in the background, without blocking the API; a conversion that was running keeps going and the test starts after it.
2. **Run benchmark** on the Settings page (`POST /api/benchmark`, **409** while one is running, `DELETE` cancels). The pool is held at once: the chapters being read finish, none starts, and the test starts when they are done.
3. **`pnpm benchmark`** (`node dist/server/benchmark/cli.js`, also in the container) prints the tables below without touching the app's data. It asks the running app first and refuses while it is converting or testing (`--force` to override), because it would compete with it.

**The gate.** `PoolGate` (`convert/pool-gate.ts`) counts holds; workers claim no chapter while one is held, and a conversion queued meanwhile starts the moment the hold is released. A hold set while a chapter is running waits for it, never aborts it. A cancelled wait lifts the hold again. The startup run takes the hold only at an idle moment, decided in the same tick as the worker's "nothing to claim", so no chapter can slip in between. The startup run also waits while an M4B/ZIP build is running (`busyElsewhere`, with a check when the last build ends), and a start by hand while it is still waiting takes it over instead of being refused. While held, `GET /api/pool` and the `pool` event say `held: true` and the app shows "Measuring how fast this computer reads aloud".

**Cancel** aborts the signal that reaches every `synthesize` call: a Piper process that is working is killed (its process group), the sessions are closed and awaited, the scratch folder is removed, the hold is released, and nothing is saved (results are written together, in one transaction, when every voice is done, with the load average at the start and the end and how long the run took (migration 9); a voice that cannot be measured is skipped and the others are kept). Checked in the container: no `piper` process is left after a cancel.

Results live in `benchmark_results` (one row per engine and voice, replaced by the next run) with the CPU count and model, the text version and the time; `GET /api/benchmark` returns them with the state of a run, and the `benchmark` event carries its progress.

## Estimates

- **Audio length** of a book = prepared characters x the voice's speech rate. The prepared character count is made **once, in the background**, and stored per chapter (`chapters.prepared_chars`, migration 8): the upload (and a change of language on the preview) is answered at once with the counts missing, the book says it is *measuring* (`measuring: true`, no estimate yet), and the `book-counted` event tells the pages when they land. A `PreparedCounter` counts one chapter at a time per book with at most 2 text rule threads in all (shared with the estimate route), stops starting any after the first chapter whose rules time out or run out of memory or after 60 s per book (the rest count at their raw length), drops a count when the book was deleted or its language changed meanwhile (the write is conditional on the language), and stops at shutdown. The counts are forgotten and made again for unfinished books when `TEXT_PROCESSING_VERSION` changes, and made for books from before the migration at startup. `GET /api/books/:id/estimate?language=` answers for another language without changing the book (one count per book and language, shared by requests that arrive together, at most 3 languages at a time, 429 beyond; it asks the same-origin check like a POST does).
- **Conversion time** = a step through the schedule, not a division (`conversionSeconds`): N workers take the chapters in order, each chapter costs its audio over the single-session speed plus 0.3 s (text preparation and the join: 45 ms for a 21,000 character chapter and 125 ms for 20 chunks, measured in the container), and while `k` workers are busy each runs at `throughput(k) / (k x throughput(1))` of its single speed, with `throughput` drawn as straight lines between the measured points and flat beyond the last. So the last chapters, which run with fewer workers, are not hidden by an average. The result is multiplied by the learned slowdown.
- **Time left** = the same schedule over the chapters not finished (running ones by what is left of them, failed ones left out), plus, for a book waiting in the queue, the time the books in front of it need ("Starts after 2 books, in about 1 h. Then ..."). A paused book and a paused pool show words, not a number. While the pool is held for the speed test and none of the book's chapters is running, the state is `waiting_for_speed_test` and the pages say "Waiting for a speed test (about 2 min), then about 3 min left" (the test's expected length is what the last run took, 3 minutes before any). The pages recompute it from the chapters as they progress, with the same shared function.
- **Learning.** After each finished chapter (not one that resumed from saved chunks or retried a chunk) the voice's speech rate and a **slowdown** are moved with a running average: the slowdown is the chapter's real time over what the benchmark says for the audio it produced at the **average number of busy workers** while it ran (`ConcurrencyMeter`), so the load of the machine, other programs included, shows in the estimates. The first chapter moves the numbers half way, later ones a quarter; a single chapter cannot move the slowdown by more than a factor of 2 either way from what it is now (so an outlier first chapter, a stall say, costs half a step), and the learned speech rate stays within 25% of the benchmark's. A chapter that ran while the pool was held, released or resumed is not learned from. After 3 chapters the estimate is called "learned". A new benchmark clears what was learned for the voice.
- **Rough.** A voice that was never measured uses built-in defaults (the numbers below, rounded), and the pages say "rough estimate" until a benchmark has run.
- **Wording** (`formatApprox`): under a minute is "under a minute", whole minutes under ten, five minutes up to ten hours, ten minutes beyond; always "about".

## Measured here

Machine: the eval container (`gan-harness/run-in-image.sh`, Docker Desktop on an Apple M4 Pro, 12 cores, 7.75 GB, arm64 Linux, Piper 2023.11.14-2, native, no emulation) on 2026-10-22. **The host was busy with other programs the whole time**: the 1-minute load average was 3 to 9 when a run started and 15 to 58 during several of them (other applications, not this one), so every time below is, if anything, worse than a quiet machine would give; the speech rate does not depend on load, the factors and throughputs do. Four full benchmark runs, all three default voices:

| Run | Load avg (1 min) at start / during | Sample reads |
| --- | --- | --- |
| A, first start (idle pool) | 5.4 / 5 to 15 | 3 (took 4 min 25 s) |
| B, Run benchmark button | 4.0 / 8 to 25 | 2 (took 2 min 42 s) |
| C, `pnpm benchmark` in the container | 2.9 / up to 41 | 2 (took 2 min 36 s) |
| D, first start of the final build | 20 / about 20 | 2 (took 2 min 44 s) |

| Voice | Audio per 1,000 characters (A to D) | Real-time factor, one session (A to D) | Opus encode / audio | Model load |
| --- | --- | --- | --- | --- |
| `en_US-lessac-medium` | **57.0 s** (56.7 to 57.4) | **0.042** (0.040 to 0.046), 24x real time | 0.0087 (0.0086 to 0.0090) | 0.2 to 0.8 s |
| `uk_UA-ukrainian_tts-medium:lada` | **59.6 s** (59.5 to 59.6) | **0.039** (0.036 to 0.050), 26x | 0.0087 (0.0084 to 0.0114) | 0.25 to 0.3 s |
| `ru_RU-ruslan-medium` | **64.6 s** (64.2 to 65.5) | **0.041** (0.040 to 0.043), 24x | 0.0085 | 0.2 to 0.3 s |

- **The speech rate is the stable number** (within 2% across four runs and different loads); the real-time factor moves by 10 to 40% with the load of the host.
- **A manual check**: one 22,936-character English "chapter" (the sample 20 times, 24 chunks, 22 minutes of audio) read by one Piper session in the container took 55.0 s: factor 0.042, 57.1 s per 1,000 characters, which is what the benchmark says.
- **The Opus encoding is about a fifth of the synthesis time** (0.0087 against 0.042 s per second of audio). One 57 s chunk takes about 0.3 s to encode; text preparation of a 21,000 character chapter takes 45 ms and joining 20 chunks 125 ms, which is where the 0.3 s per chapter comes from.
- **More workers help little.** Audio per second of waiting with 1, 2, 3 and 4 sessions at once (the range over the four runs is shown, because the load of the host moves it):

  | Sessions | 1 | 2 | 3 | 4 |
  | --- | --- | --- | --- | --- |
  | `en_US-lessac-medium` | 18.3 to 20.7 | 21.4 to 26.6 | 23.3 to 27.8 | 21.8 to 27.3 |
  | `uk_UA...:lada` | 16.2 to 22.2 | 22.2 to 31.1 | 24.6 to 34.3 | 25.2 to 35.3 |
  | `ru_RU-ruslan-medium` | 19.5 to 20.6 | 21.1 to 25.2 | 21.0 to 25.8 | 21.8 to 26.2 |

  One session already uses most of the machine: a single `piper` process reading 8 copies of the sample (23 MB of WAV) took 22 s of wall time and 162 s of CPU time, 7.3 cores on average (ONNX Runtime starts its own threads in each process), so 2 sessions give 1.2 to 1.4 times one, and 3 or 4 about as much as 2 to 3: **the benchmark's hint is 3 workers** (the fewest within 5% of the best), while the default is half the cores, 6 here. Extra workers cost memory and nothing else.
- **A 90,000-word novel** (the yardstick on the Settings page: 30 chapters of equal length, 5.8 characters per word in English, 7.3 and 7.1 in Ukrainian and Russian, which are the longer words of those languages): 8.3 h of audio in English, 10.9 h in Ukrainian, 11.5 h in Russian (the spec's "about 10 hours"), converted in **19 to 24 min (English), 24 to 30 min (Ukrainian), 27 to 32 min (Russian) with 2 workers**. With 1 worker 25 to 35 min, with 4 or 6 the same as with 2 or 3.

### Predicted against real

Whole books through the real app (Piper, ffmpeg, the worker pool), time from the Convert click to the last chapter done (the M4B and ZIP that are built afterwards take about 4 minutes more for 7.7 hours of audio, with the host at load 30, and are not part of the estimate):

| Book | Workers | Predicted at the start | Real | Error | Host load during |
| --- | --- | --- | --- | --- | --- |
| generated novel, 91,062 words, 24 chapters, 7.67 h of audio (length predicted 7.70 h, +0.4%) | 2 | 22.1 min (benchmark only) | 23.4 min | **-5%** | 4 at the start, 17 to 58 |
| 30,727 words, 8 chapters, 2.6 h | 4 | 6.0 min (benchmark only) | 8.8 min | **-32%** | 19 to 50 |
| the same, with the 4-worker run learned from (slowdown 0.92 then) | 2 | 6.9 min | 6.8 min | +1% | 32, falling to 14 |
| the same, final build | 2 | 6.6 min | 6.6 min | -1% | 9 to 20 |

The -32% row is the honest weak spot: the benchmark was taken at a lighter load than that run had, and four Piper processes plus the other programs on the host were all competing, so every chapter took about 1.4 times the benchmark's time. **The estimate corrected itself while the book ran**: the time left was still 30% too low three minutes in, before any chapter had finished (four chapters at once, each one long), 14% too low when the first finished, 9% too low after 4, 6% a minute later, and right at the end (`learned` from the 4th chapter on; the slowdown ended at 1.41). Over the whole of the first book the time left was between 4% and 15% too low at every look (median -9%), never too high. Learning is what makes the second book of the same size, run under similar conditions, come out within 1% (rows 3 and 4).

## Proposed speed target (for the owner to confirm)

> **A 90,000-word novel (about 10 hours of audio) is converted in under 40 minutes with the default settings, which is at least 15 times faster than listening to it, on the owner's machine.** The check is `pnpm benchmark` (or the Settings page) showing "90,000-word novel" under 40 minutes for all three voices with the default worker count.

**Where 40 comes from, and how soft it is.** It rests on noisy runs. The "90,000-word novel" figure for one voice swung between runs on this machine, because the host was busy with other programs each time (1-minute load average at the start of the runs: 2.9, 4.0, 5.4, 5.9, 20, with 15 to 58 during several of them, on 12 cores): English 19 to 25 min, Ukrainian 20 to 30 min, Russian 27 to 34 min with 2 workers (the 34 was the evaluator's `pnpm benchmark` at load 5.9; my own runs gave 27 to 32). The slowest voice, Russian, has the longest words and the lowest speech rate. 40 minutes gives about 15 to 20% headroom over the worst of them, where the 35 minutes proposed first had 3%. The Settings table shows one run, not an average, so two runs can differ by that much; the run is read twice per voice to smooth it, and the learning corrects the estimates, but the table itself stays a single reading. A benchmark taken while the host is busy **overstates** the time of later conversions (the evaluator saw a book predicted 17% too long after a benchmark at load 24), and one taken while it is quiet **understates** them (the 32% case above): that is why a run that began with the load above the number of cores is repeated once at the next start, and why the Settings page says how busy the computer was.

It is a statement about this machine: another computer gets its own number from the same test, and the app never promises a time, it shows its estimate before each conversion. A machine that comes out slower than 5 times real time (a 90,000-word novel over 2 hours) is where thread tuning, a smaller worker count or a GPU (out of scope) would be worth a look.

**Default worker count.** The default is half the cores (6 of 12 here), and **that is wasteful on this machine**: one Piper process already uses about 7 cores, the throughput stops growing at 2 to 3 sessions, and every extra worker holds a model in memory for nothing. Recommendation, not applied: make the default `min(cores / 2, 3)` (a one-line change in `SettingsStore`). It needs the owner's decision, because the right number depends on how many threads Piper is told to use (known gap below).

## Known gaps

- **Piper threading is not tuned** (out of scope): each process uses several ONNX threads, which is why more workers add so little. Limiting the threads per process and running more of them might scale better; the benchmark would show it.
- **The numbers move with the load of the host**, and the benchmark is a few minutes taken at one moment. Learning corrects the estimates, but only after a few chapters, and the first book after a quiet benchmark on a busy day is optimistic (the -32% row).
- **Only this app's workers are counted** in the number of busy sessions; other programs show up in the learned slowdown, not in the curve.
- **The per-chapter overhead is a constant** (0.3 s); a book of thousands of tiny chapters would be underestimated, and a single multiplier (the slowdown) is shared by the synthesis and the overhead.
- **The M4B and ZIP build after the last chapter** is not in the time left (it has its own progress and time left, slice 4).
- **The text rules run once more** for a language that is not the book's own when the preview asks (cached for six book and language pairs, about 40 ms per chapter of 20,000 characters).
- The throughput curve of a single run is noisy (the 3 and 4 session points can swap places); a run repeated a few times, or the learning, smooths it. The benchmark reads each sample twice; reading it more times would smooth it further for a longer test.
- The CPU model is "arm64 processor" in Docker on Apple silicon, because the VM does not report it; the CPU count and the architecture still tell machines apart.
