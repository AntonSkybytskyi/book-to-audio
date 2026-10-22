# Decision: default Piper voices

Status: accepted (ANO-14, slice 5) · Decision: **`en_US-lessac-medium`**, **`uk_UA-ukrainian_tts-medium`** (speaker `lada`) and **`ru_RU-ruslan-medium`**, all from `rhasspy/piper-voices` at revision `5041a7a49ae5b3a0f30e6837769eb03fdbb231bd`, checked with sha256 in the Dockerfile.

The spec (sections 6 and 7) wants one default voice per language, no picker (section 13). The list lives in `src/server/tts/voices.ts`; `PiperEngine.voices()` puts these first, so a language's voice is the first one listed for it even if more models are in the voices folder.

## What was compared

All run inside the app image with the real Piper binary, on the same text (two or three plain sentences).

| Voice | Size | Speech for the same text | Notes |
| --- | --- | --- | --- |
| `uk_UA-ukrainian_tts-medium`, speaker `lada` (id 0) | 77 MB, 3 speakers | 8.3 s | the pace of a calm reader; real-time factor about 0.23 |
| same model, `tetiana` (id 2) | | 8.9 to 9.1 s | |
| same model, `mykyta` (id 1, male) | | 11.2 s | about a third slower |
| `uk_UA-tetiana-high`, `-mykyta-high`, `-oleksa-high` | 114 MB each | not compared | newer, single speaker, "high" quality, slower to run; the spec asks for medium voices, so they are a later upgrade |
| `uk_UA-lada-x_low` | 21 MB | not compared | too low in quality |
| `ru_RU-ruslan-medium` | 63 MB | 8.9 s | |
| `ru_RU-irina-medium` | 63 MB | 10.7 s | |
| `ru_RU-denis-medium` | 63 MB | 10.0 s | |

Piper normalises each file to full scale, so loudness and clipping do not tell the voices apart, and no voice produced a gap, a cut-off or an empty file on these texts. **Nobody listened to them while this was written**; the choice rests on what the model cards say and on pace. If the owner prefers another voice, it is a one-line change in `voices.ts`.

- **Ukrainian: `ukrainian_tts-medium`.** It is the only medium Ukrainian model in the repository, and the one the spec names. Its three speakers come from the open `ukrainian-tts` data set (Lada, Tetiana, Mykyta). **Lada** is a female voice and reads at the fastest, evenest pace of the three, which keeps a book's length down. Tetiana is the alternative.
- **Russian: `ruslan-medium`.** As far as its model card says, it is trained on the RUSLAN corpus, a single studio speaker recorded for speech synthesis. It also reads fastest of the three medium voices tried. Irina is the alternative.
- **English** is unchanged.

## A multi-speaker model is one voice with a speaker

`uk_UA-ukrainian_tts-medium` has three speakers (`speaker_id_map` in its config). The engine lists it as one voice, `uk_UA-ukrainian_tts-medium:lada`, whose `speaker` is `lada`:

- the voice id includes the speaker, so changing the speaker is a different voice;
- the session sends `"speaker_id": <number from the config>` with every line of the `--json-input` protocol (checked: ids 0, 1, 2 give three different voices);
- `meta.json` in a chapter's chunk folder records `voice` and `speaker`, and a difference in either discards the chunks on resume;
- a model whose config no longer has the chosen speaker is not listed at all, and the bare model name is not a voice.

## What the Ukrainian model cannot do

Its config says `"phoneme_type": "text"`: it is **character based**, not phoneme based, and does not use espeak-ng at all. Its alphabet is the lower-case Ukrainian letters, a few punctuation marks (`! ' , - . : ; ? —`), the combining accent and the space. Verified with `piper --debug`: Piper lower-cases the text, and **digits, Latin letters and most symbols are dropped without a sound** ("Missing 29 phoneme(s)" for one fixture chapter). The curly apostrophe is not in the alphabet either, so "дев’ятнадцятого" would lose its apostrophe. That is why the Ukrainian rules in `docs/decisions/text-processing.md` spell every number, turn Latin names into Ukrainian letters and clean the characters. The Russian voices use espeak-ng and read digits and Latin words themselves (English words in Russian text switch to espeak's English).

## Size

The image grows by about 140 MB (the two new models). `docker compose build app` still builds (checked), and the voices stage fetches each file at the pinned revision and verifies its sha256.
