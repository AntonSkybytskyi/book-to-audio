# Decision: language detection and text rules for speech

Status: accepted (ANO-14, slice 5) · Code: `apps/api/src/books/language-*.ts` (detection), `apps/api/src/text/` (rules and sentence splitting).

## Language detection

**An in-house detector**, about 90 lines (`language-detect.ts`) plus word lists (`language-words.ts`), no dependency. The problem is three languages, one of which (Ukrainian against Russian) is decided by letters, so a general library (CLD-style n-gram models, megabytes of tables, native code or WASM) would add more than it removes, and could not be told that a "wrong" answer such as German must become "unsure".

- **Sample.** `sampleBookText` takes the whole text of a short book, and for a longer one 40 windows of 1,500 characters spread evenly over all chapters taken together (at most 60,000 characters). A copyright page in English in front of a Ukrainian book is a small part of the sample.
- **Script.** Cyrillic letters against Latin letters decide the path (at least 150 letters, else "unsure").
- **Ukrainian or Russian.** Evidence is counted: the letters only one of them uses (`і ї є ґ` against `ы э ё`) plus function words only one of them uses (`що як це але він` against `что как это но он`; shared words like `не`, `на`, `та`, `все`, `тому` are left out of the lists). The verdict is the share, and its confidence is `|2 share - 1| x min(1, evidence / 30)`, so 30 pieces of evidence on one side are certain and a mixed text is not. Letters of other Cyrillic languages (Belarusian `ў`, Serbian `ђ ћ љ њ џ`, Macedonian, Kazakh/Tatar/Kyrgyz/Mongolian `ә ғ қ ң ө ұ ү һ җ`, Chuvash `ӑ ӗ`), or a lot of `ъ` without `ы э ё` (Bulgarian), give "other": `ы э ё` alone do not make a text Russian.
- **English or other Latin text.** The share of the 70 most frequent English words (35 to 50 percent of English prose) is compared with the same share for German, French, Spanish, Italian, Portuguese, Dutch and Polish/Czech lists. English needs at least 22 percent and a margin; less than 15 percent English together with a clearly foreign list is "other"; in between is "unsure".
- **Result:** `language` (certain), `other` (a language the app does not support) or `unsure` (too little text).

### Combined with `dc:language` (`language-choice.ts`)

| Text says | Metadata says | Pre-selected | `language_source` | Preview says |
| --- | --- | --- | --- | --- |
| a language, confidence 0.7 or more | anything | the text's language | `detected` | "Detected: Ukrainian" (and "The book's metadata says English, but the text is Russian" when they differ) |
| unsure, or low confidence | `en`, `uk` or `ru` (also `uk-UA`) | the metadata's | `metadata` | "From the book's metadata: Ukrainian ... Please check" |
| unsure | nothing usable | English, as a placeholder | `unknown` | "Could not detect the language ... Please pick the right one" |
| **other**, Latin script (German, French ...) | `uk` or `ru` | the metadata's (a Ukrainian or Russian book can be mostly Latin letters: product names, quotations) | `metadata` | "From the book's metadata ... Please check" |
| **other**, Latin script | `en`, nothing, or another language | English, as a placeholder | `unknown` | "Could not detect the language" |
| **other**, Cyrillic (Bulgarian, Kazakh ...) | anything | English, as a placeholder | `unknown` | "Could not detect the language" |
| (the owner picks another language) | | the pick | `chosen` | the plain note |

When the source is `unknown` the preview does not pre-select English: the select shows "Choose a language..." and Convert stays disabled until the owner picks one, so a German book is never converted as English by one click. `POST /api/books/:id/convert` also answers 409 `language_not_chosen` for a ready book whose source is `unknown`, so no API client converts a placeholder. **Migration 7** marks every book that was already in the library `chosen` (the owner or the metadata set their language, the text never did), so no old book asks to be checked; only books added afterwards can be `unknown`.

Stored in `books.language_source`, `language_confidence` and `declared_language` (migration 7). `PATCH /api/books/:id` sets `chosen`. A German book is never labelled English with confidence: the placeholder is only a starting point, and the note says so.

### Known limits

Mixed books are decided by their larger part. A very short book (under 150 letters, or about 30 pieces of Ukrainian/Russian evidence) falls back to `dc:language`. Surzhyk (mixed Ukrainian and Russian) is whatever predominates. A German (or French ...) book whose metadata says `uk` or `ru` is taken for that language, with the "please check" note. Languages that are neither supported nor in the word lists (say Turkish) are only recognised as "other" by their low share of English words.

## What espeak-ng and Piper already do

Checked in the app image with `/opt/piper/espeak-ng -v <voice> --ipa` (the same engine and data that Piper's phonemizer calls; the binary in the tarball is not marked executable, so it was copied and `chmod +x`ed first), and with `piper --debug` for the Ukrainian voice.

**Ukrainian is different: the voice does not use espeak-ng.** It is character based (see `voices.md`), so digits, Latin letters, `%`, `$`, `№` and every symbol outside its small alphabet are dropped. Raw fixture text lost 29 kinds of symbols; the prepared text loses none. (For reference, espeak's own `uk` voice reads "1999" as "один тисяча дев'ятсот ...", wrong gender, so it would not have been better.) Everything in the Ukrainian column below is therefore written by the rules.

The principle for every rule: **a wrong expansion is worse than none**. Where the case, gender or meaning cannot be told, Russian and English leave the text to espeak, and Ukrainian (whose digits would vanish) spells a plain nominative cardinal. A rule never produces a form it is not sure of.

| Case | English (espeak) | Russian (espeak) | Ukrainian (voice) | What the rules do |
| --- | --- | --- | --- | --- |
| cardinals (3, 21, 12 000) | right | right, masculine ("21 яблоко" is "двадцать один яблоко") | dropped | uk: spelled, genitive after до, від, після, близько ... ; ru: only 1 and 2 before a noun in the lists |
| decimals (3,5; 3.14) | right | "три и пять десятых" | dropped | uk: "три цілих п'ять десятих" (genitive after до ...); ru: left |
| years (1999) | **wrong**: "nineteen hundred ninety nine", 1066 as "one thousand sixty six" | **wrong**: cardinal, "в одна тысяча ... девять году" | dropped | en: 1010 to 1999 in context; ru/uk: ordinal in the case of "году / года / р." or of the preposition; "с 1914 по 1918 год" both ends; ranges "в 1914–1918 гг." both ends; uk "(1814–1861)" |
| decades (1990s, 1990-е, 20-ті) | **wrong**: "nineteen hundred ninety s" | **wrong**: "тысяча девятьсот девяносто е" | dropped | en "nineteen nineties"; ru/uk plural ordinal in the case of the ending ("девяностые", "дев'яностих") |
| ordinals (1st, 21-й, 3-го) | right | **wrong**: "двадцать один краткий", "три го" | dropped | ru, uk: the ending tells the form (see below) |
| dates (3 июня, 21 грудня, 12.05.2020) | right | **wrong**: "три июня" | dropped | ru, uk: neuter genitive ordinal; "с 5 по 10 июня" both ends; numeric dates |
| percent (15%, 3,5%, 10-15%) | right | **wrong**: "пятнадцать процент" | dropped | ru: digits and the noun in its form ("15 процентов"); uk: words, genitive after до ...; ranges both ends |
| currency (5 руб., $5, 12,50 грн.) | right | **wrong**: "руп", "доллар пять" | dropped | ru: digits, noun in its form, a feminine 1 or 2 spelled ("двадцать одна копейка"); uk: words; amounts with kopecks; ranges |
| times (10:30) | right | right | dropped | uk: "десять тридцять"; "о 5 годині" as "о п'ятій годині" |
| Roman numerals (IV, XIX, World War II, Henry VIII) | **wrong**: "roman four" | **wrong**: "ай ви" (as English letters) | dropped | in context only (below) |
| abbreviations | right: Mr., Dr., St., etc., e.g., No. 5, a.m.; **wrong**: Jr. "J R", Mt. "M T", Inc. "ink", ch. "C H", pp., vs. "V S", Col. "kal", Rev., Ph.D. | **wrong**: т. д. "тэ дэ", т. е., см. "эс эм", г. "гэ", им. | dropped | the wrong ones only, and not where the abbreviation is also a word ("им" the pronoun, "рис" the rice) |
| `№`, `/`, brackets, quotes | read or ignored | read or ignored | dropped | uk: `№` as "номер", brackets as commas, others become spaces |
| Latin words in a Russian text | read in English, by espeak | | dropped | uk: spelled with Ukrainian letters |

## Rules (`apps/api/src/text/`)

Pure functions per paragraph (`prepareForSpeech(text, language)`), applied before the text is chunked. Everything is deterministic; `*.test.ts` next to each module lists inputs and outputs, and `golden/` has a table per language of the examples a native reader checked (`golden/*.ts`, run by `golden/golden.test.ts`).

- **English** (`english*.ts`):
  - Years 1010 to 1999 after in/since/by/from/until/during/before/after/around/circa/year/early/late/mid/between or a month, in "June 3, 1999", before AD/BC, and in "(1812–1870)"; decades (`1990s`, `mid-1800s`); ranges (`1914-1918`, `from .. to ..`, `between .. and ..`, and `1914-18`, `1999-2000` where a year is expected). Not read as years: a number followed by a word that counts or measures ("by 1200 men", "in 1500 words", "between 1200 and 1500 dollars"), "1,999", "$1999".
  - Roman numerals after Chapter, Part, Book, Volume, Act, Scene, Canto, War, Psalm, Stanza (I, V, X, L, C up to 150, a lone letter only I, V, X), after Section, Appendix, Article, Plate, Table, Figure, Exhibit only as two or more letters of I V X up to 39 ("Appendix C", "Section D", "Part MIX" stay); a lone numeral after a keyword that is not capitalised ("they act I suppose") only before a stop or "of"; regnal names from a fixed list ("Henry VIII" as "Henry the 8th"; "Mary V. Smith" is an initial). Numerals become digits, which espeak reads ("World War I" is "World War 1", read "one").
  - Abbreviations Jr., Sr., Inc., Corp., Co., Ave. (after a capitalised word), Mt., Lt., Col., Sgt., Capt., Gen., Adm., Maj., Cmdr., Gov., Sen., Rev., Prof., Pres., Supt., Mme., Ms., Sts. (before a capital), vs., cf., Ph.D., ca./ch./pp./vol./fig. before a number and ft. after one (a final dot is kept before a capital).
- **Russian** (`russian*.ts`, `slavic/`): the locative ordinals of the Ukrainian list ("на 5 странице", "в 7 классе"), a year straight after a date, "-й" before a feminine noun ("с 3-й попытки", "в 3-й школе"), decade ranges, the feminine accusative of 1 ("21 книгу"), look-alike letters, and: years (`1999 году`, `1812 г.` with a preposition, `с 1914 по 1918 год`, `в 1914–1918 гг.`), dates (also `с 5 по 10 июня`, `12.05.2020`), centuries (`XIX веке`, `в XIX в.`, `XVIII–XIX веках`, `в 21 веке`), decades and plural ordinals (`1990-е годы`, `в 90-е`, `20-х`), regnal numbers from a list in the nominative and genitive, chapter headings (`Глава IV`, `в главе IV`, `Глава 1` as "первая"), numbered titles, ordinals with an ending (`21-й век`, `3-го`, `3-му`, `в 3-м классе`, `5-я`, `3-ей`, `в 5-й школе`), percent and money (digits with the noun in its form), a feminine or neuter 1 or 2 from a list of nouns, abbreviations (т. д., т. п., т. е., т. к., т. ч., и др., и пр., напр., см., им. after a noun that is named after somebody or before initials, г. before a capital, рис., т., стр., гл., ч., п., ст., табл., вып., кн. before a number, проф., акад.).
- **Ukrainian** (`ukrainian*.ts`, `slavic/`): the same list, plus:
  - every other number spelled, as a nominative cardinal, or a genitive after до, від, після, біля, близько, поблизу, навколо, довкола, для, без, протягом, упродовж, поза, окрім, крім, замість, серед, коло, and in "з/із N до M";
  - the feminine "о N годині" locative, times, `№`;
  - "-й" with a feminine locative noun ("у 5-й школі"), the endings а я ша га тя та ма ій ої ї ою, plural endings ті і х их ми ими;
  - century and year ranges, dates `dd.mm.yyyy` (a genitive in running text, a nominative on a line of its own), "5–10 червня", a year straight after a date ("9 березня 1814" with "тисяча вісімсот чотирнадцятого"), two decades ("1960–1970-х");
  - a number before a singular locative noun after на, у, в, при ("на 5 сторінці", "у 7 класі", "на 10 поверсі", "у 9-А класі") as a locative ordinal with the noun's gender;
  - fractions with a smaller numerator ("1/2" as "одна друга", "3/4" as "три четвертих", "7/12"), "2×2" as "два на два", phone numbers (3+4 digits or three groups) digit by digit with a pause between groups; any other slash between numbers is a pause;
  - 1 and 2 agree with the nouns in the lists, with the endings -ння -ття -ище -ство (neuter) and -ість -ція -сія -зія (feminine) for 1, and with the feminine accusative ("21 книгу" as "двадцять одну книгу");
  - Latin look-alikes inside a word with Cyrillic letters ("Cкоро" typed with a Latin C) are made Cyrillic first (also in Russian);
  - a Roman numeral that no rule placed (II to XXXIX in I, V, X) as a cardinal, never as a word; Latin acronyms letter by letter, other Latin words approximated;
  - digits glued to the end of a Cyrillic word (`слово1`, `пішов.2`) are note markers and dropped;
  - the voice's alphabet (apostrophes, ellipsis, dashes, quotes removed, brackets become commas, other symbols spaces, `ё ы э ъ` to their Ukrainian look-alikes).
- **Declension** is table driven (`slavic/numerals*.ts`: cardinals, ordinals in six cases and three genders and the plural, counted noun forms, Ukrainian genitive cardinals). Where a rule has to guess a case it looks at the preposition or the form of the word that follows; if there is no evidence it **leaves the text alone** (ru, en) or spells the nominative (uk).

### Roman numerals only in context

A numeral is read only after a heading word, before a century word, after a regnal name from the list, or when the paragraph is just the numeral. A heading word takes I, V, X, L, C (up to 150, one letter only I, V, X); a label word (section, appendix, article, plate ...) takes only two or more letters of I, V, X. D and M never count after a heading ("Part MIX", "Section M"). The Cyrillic `І Х С М` count only where a numeral is expected, because `І` is also "and" in Ukrainian; a single Cyrillic І or Х is never a regnal number.

## Limits that keep a hostile text from freezing the server

- Each paragraph is cut at 5,000 characters (at a stop, else a space, else anywhere) before any rule sees it (`text/index.ts`), so no rule can take more than the square of that.
- The sentence splitter's regular expression cannot start inside a run of stops (`(?<![.!?…])`), and every unbounded `\d+` has a lookbehind or a cap: runs of more than 30 digits are dropped in Ukrainian, groups of digits join at most four at a time.
- Preparing a chapter (`prepareChunks`: rules then chunking) runs in a worker thread with a memory cap and a time limit of 20 s plus one second per 100,000 characters (`convert/text-preparer.ts`). A chapter that runs over fails with `bad_input` and a clear message; that is the text's fault and is not counted by the circuit breaker.
- `text/redos.test.ts` runs 27 hostile shapes (runs of digits, dots, spaces, hyphens, Roman letters, ranges ...) and random mixes through every language under a time budget; the splitter gets 200,000 dots, 100,000 `?!` pairs and 50,000 ellipses in under 200 ms.

## Sentence splitting (`sentences.ts`)

Replaces `Intl.Segmenter`, which breaks after "Mr.", "St.", "Dr.", "J.", "т.", "ім." and "Vol." (checked on Node 24; its results also depend on the ICU build, which a resume must not). A stop ends a sentence only when the next word does not start with a lower-case letter, and not after an abbreviation of the language's list (en, uk, ru, `sentence-abbreviations.ts`), not after initials (`J. R. R. Tolkien`, `Т. Г. Шевченко`) unless the word after is one that starts sentences ("Plan B. Then he left"), not after a number-bound one before a digit (`No. 5`, `рис. 3`), and for abbreviations that may end a sentence (`etc.`, `т. д.`, `p.m.`) only before a capital that is not another abbreviation ("Co. Ltd."). Words that are also abbreviations are not in the lists ("sat", "sun", "wed", "gal", "рис" as a sentence end). When unsure it does not split: a sentence that is too long is split on spaces by the chunker, while a split in the wrong place is an audible pause.

## Versioning

`TEXT_PROCESSING_VERSION` (`text/version.ts`) is in every chunk folder's `meta.json` next to engine, voice, speaker, sample rate and chunk count. A chapter that resumes with another value starts again. `golden/golden-hash.test.ts` hashes what the rules produce for the golden inputs and the sample books and fails when the hash changes without the version: set both values in that test when a rule changes what comes out. The version is 3 (iteration 003 of this slice).

## Known gaps

Each item is a reading the rules do not get right. Where a rule is unsure, Russian and English leave the text to espeak and Ukrainian spells a nominative cardinal; both are wrong in the cases below, and the lists say which.

Ukrainian (a nominative cardinal where another form is needed, or a word read as it is written):

- Cases other than the ones the rules know: "з 5 дітьми" (instrumental), "по 5" and datives are read "з п'ять дітьми". Genitive only after до, від, після, біля, близько, поблизу, навколо, довкола, для, без, протягом, упродовж, поза, окрім, крім, замість, серед, коло, and in "з N до M".
- The plural locative: "на 5 сторінках" is read "на п'ять сторінках", "у 5 класах" "у п'ять класах"; "у 2 році" is read "у два році" (a number before "році" is left, since it may be a year).
- 1 and 2 take their gender only from the lists (about 190 feminine and 100 neuter nouns), the endings above and the label nouns: "1 нічка" is read "один нічка", "2 нові статті" "два нові статті" (an adjective between number and noun hides the noun), a feminine noun not in the lists after 1 or 2 is read masculine.
- "1,000" is a decimal ("одна ціла нуль тисячних"), "3.5" is "три крапка п'ять", a fraction with a numerator that is not smaller ("3/2") is two numbers with a pause, dates written "1/2/2020" are read as numbers with pauses.
- Units (`км`, `кг`, `г`, `°C`: "20 °C" reads "двадцять сі"), `вул.`, `просп.`, and `ім.` after a word that is not in the list of things named after somebody ("ім. Шевченка" stays "ім. Шевченка", read letter by letter) are read as written.
- A year without "рік" or "р." is a cardinal ("у 1999"); "1914–1918" without a word is a cardinal pair; "рр." with no preposition is a nominative ("роки").
- Roman numerals outside the contexts (II to XXXIX in I, V, X) are cardinals; a regnal number needs a name from the list in the nominative or genitive, and a lone I, V or X must be Latin.
- Latin words are approximations of the sound ("Hello world" reads "Гелло ворлд"); acronyms are spelled letter by letter even when people say them as words (NASA reads "ен ей ес ей").
- Digits glued to a Cyrillic word of four or more letters are dropped as note markers, so a real "слово1" count is lost.
- "3 століття" stays a count; digit centuries are only read before "століття" in a form no count can have (`у 21 столітті`, `до 21 століття`).
- Phone numbers that are not written as 3+4 digits or three groups ("12-34") are read as a range of numbers.

Russian (digits left to espeak, or text left as written):

- Digits are read by espeak as masculine nominatives in every case ("до 5 рублей" reads "до пять рублей", "на 5 страницах" "на пять страницах"); only the noun is in its form. A 1 or 2 is spelled only before the listed feminine and neuter nouns.
- Left as written, and read badly by espeak: a bare `3-й`, `2010-е`, `1900-е` and `1990-м` with no year word or preposition, `-й` before a word that is not clearly masculine or feminine, `-м` without a preposition, `при Петре I`, a regnal number not in the list, `1999–2000 гг.` with no preposition, `1812 г.` with none (it may be grams), `Часть II` inside a sentence.
- Roman numerals outside the contexts are read by espeak as English letters. `им.` after a word that is not in the list is read as the pronoun "им". Not expanded: `млн`, `тыс.`, units, `ул.`, `пр.`, `д.`, `1/2`, `5–10 июня` (digits), decimals other than percent.

English:

- Years need a context word ("It was 1999" stays digits and is read "nineteen hundred ninety nine"); "1914-18" needs one before it.
- "Section X" and "Article V" (letters that are often labels) and a lone I, V or X after a lower-case keyword are left, and read by espeak as "roman ten". Regnal numbers need a name from the list.
- Fractions (`1/2`), `5 in.`, `St.` for Street and `Dr.` are left to espeak.

Everywhere:

- A paragraph over 5,000 characters is cut (not inside a surrogate pair), and a rule that needs words on both sides of the cut does not fire.
- The splitter does not split "He lived in the U.S. He moved" (it joins: safe).
- The golden hash notices a change in the output for its corpus, nothing more (`golden-hash.test.ts` says what to do).
- Voices were chosen by model, size and pace, not by listening (`voices.md`).
