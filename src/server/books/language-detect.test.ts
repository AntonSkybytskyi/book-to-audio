import { describe, expect, it } from "vitest";
import { parseEpub } from "../epub/parse.js";
import { germanBook, russianBook, ukrainianBook } from "../epub/testing/sample-books-languages.js";
import { lighthouseBook } from "../epub/testing/sample-books.js";
import { chooseLanguage, sampleBookText } from "./language-choice.js";
import { detectLanguage } from "./language-detect.js";

const EN =
  "The supply boat left the harbour at dawn, and by noon the island was only a grey smudge behind it. Ansel stood on the jetty with his two crates and watched it go. Nobody had told him how quiet an island could be, and he did not know what to do with the silence.";
const UK =
  "Тарас Шевченко народився в селі Моринці. Це було давно, але він завжди пам'ятав свою родину, і його вірші читають досі. Вони були про Україну, про її степи, про долю людей, які жили тоді. Він писав і малював, і не хотів, щоб його забули.";
const RU =
  "Через базарную площадь идет полицейский надзиратель Очумелов в новой шинели. Это было давно, но он всегда помнил свою семью, и его стихи читают до сих пор. Они были о России, о её степях, о судьбе людей, которые жили тогда. Он писал и рисовал, и не хотел, чтобы его забыли.";
const DE =
  "Nahe bei dem Schlosse des Königs lag ein großer dunkler Wald, und in dem Walde unter einer alten Linde war ein Brunnen. Wenn nun der Tag recht heiß war, so ging das Königskind hinaus in den Wald und setzte sich an den Rand des kühlen Brunnens, und wenn sie Langeweile hatte, so nahm sie eine goldene Kugel.";
const FR =
  "Il était une fois un roi qui avait trois filles, et la plus jeune était si belle que le soleil lui-même, qui avait pourtant tout vu, s'étonnait chaque fois qu'il éclairait son visage. Près du château du roi se trouvait une grande forêt sombre, et dans la forêt, sous un vieux tilleul, il y avait une fontaine.";
const BG =
  "Една вечер той се върна в къщата си, която стоеше на края на селото. Тя беше стара и тъмна, а вратата ѝ скърцаше. Никой не знаеше защо е дошъл, но всички бяха сигурни, че ще остане дълго, защото в градината му растяха ябълки.";

const chapter = (text: string) => ({ text });
const book = (text: string, count = 3) => Array.from({ length: count }, () => ({ text }));
const detect = async (file: Promise<Buffer>) => {
  const parsed = await parseEpub(await file);
  return chooseLanguage(parsed.chapters, parsed.language);
};

const KK =
  "Бүгін ауа райы өте жақсы, біз қалаға барып, достарымызбен кездесіп, қызықты әңгіме құрдық. Қазақстанның көптеген қалаларында жаңа мектептер салынып жатыр, ұстаздар мен оқушылар қуанышты. Эксперимент нәтижесі ғалымдарды таң қалдырды.";
const LATIN_UK_BOOK =
  "Windows 11 Pro, Microsoft Office 365, Adobe Photoshop 2024, Google Chrome, Apple iPhone 15 Pro Max, Samsung Galaxy S24 Ultra, Sony PlayStation 5, Nintendo Switch OLED, Tesla Model 3 Long Range, Dell XPS 13 Plus, Lenovo ThinkPad X1 Carbon, Canon EOS R5, Nikon Z9, GoPro Hero 12 Black, DJI Mavic 3 Pro, Logitech MX Master 3S, Razer BlackWidow V4, Asus ROG Strix, HP Spectre x360, Acer Predator Helios. ";

describe("detectLanguage", () => {
  it.each([
    ["English", EN, "en"],
    ["Ukrainian", UK, "uk"],
    ["Russian", RU, "ru"],
  ])("recognises %s", (_name, text, language) => {
    expect(detectLanguage(text)).toMatchObject({ kind: "language", language });
    expect(detectLanguage(text.repeat(3))).toMatchObject({ kind: "language", language });
  });

  it("is confident about a normal paragraph and about a long one", () => {
    for (const text of [EN, UK, RU, EN.repeat(20), UK.repeat(20), RU.repeat(20)]) {
      const detection = detectLanguage(text);
      expect(detection.kind === "language" && detection.confidence).toBeGreaterThanOrEqual(0.7);
    }
  });

  it.each([
    ["German", DE],
    ["French", FR],
    ["Bulgarian", BG],
  ])("calls %s something else, not English or Russian", (_name, text) => {
    expect(detectLanguage(text)).toMatchObject({ kind: "other" });
    expect(detectLanguage(text.repeat(4))).toMatchObject({ kind: "other" });
  });

  it("does not take Kazakh and its relatives for Russian because of ы э", () => {
    expect(detectLanguage(KK)).toMatchObject({ kind: "other", script: "cyrillic" });
    expect(detectLanguage("Бүгін ауа райы өте жақсы, ол көп ғалым. ".repeat(6))).toMatchObject({
      kind: "other",
    });
    // Tatar, Kyrgyz, Chuvash and Belarusian letters too.
    for (const text of [
      "җыр җәй һәм ңә өч ".repeat(20),
      "ң ө ү жана ".repeat(40),
      "ў ў ў слова ".repeat(30),
      "ӑ ӗ çӑва ".repeat(40),
    ]) {
      expect(detectLanguage(text).kind).toBe("other");
    }
  });

  it("does not decide on very little text", () => {
    expect(detectLanguage("")).toEqual({ kind: "unsure" });
    expect(detectLanguage("Hello world.")).toEqual({ kind: "unsure" });
    expect(detectLanguage("Привіт, світе! Як ся маєш?")).toEqual({ kind: "unsure" });
    expect(detectLanguage("12345 67890 ".repeat(100))).toEqual({ kind: "unsure" });
  });

  it("tells Ukrainian from Russian by letters and by words", () => {
    // Only function words, no marker letters: "що" and "як" against "что" and "как".
    const uk = "що як це але він вона вони його була було вже ще чи бо ми ви ".repeat(6);
    const ru = "что как это но он она они его была было уже ещё ли мы вы ".repeat(6);
    expect(detectLanguage(uk)).toMatchObject({ kind: "language", language: "uk" });
    expect(detectLanguage(ru)).toMatchObject({ kind: "language", language: "ru" });
    // Only letters: і ї є ґ against ы э ё.
    expect(detectLanguage("їжак єдиний ґанок і сім ".repeat(30))).toMatchObject({ language: "uk" });
    expect(detectLanguage("ёжик эхо ыы синий сыр ".repeat(30))).toMatchObject({ language: "ru" });
  });

  it("goes with the larger part of a mixed text", () => {
    expect(detectLanguage(`${UK.repeat(3)} ${RU}`)).toMatchObject({ language: "uk" });
    expect(detectLanguage(`${RU.repeat(3)} ${UK}`)).toMatchObject({ language: "ru" });
  });

  it("is not thrown by English names in a Ukrainian text, or Cyrillic names in an English one", () => {
    const names =
      "Ivan Franko, Taras Shevchenko, Charles Dickens, Harry Potter, Hogwarts, New York. ";
    expect(detectLanguage(UK + names + UK)).toMatchObject({ language: "uk" });
    expect(detectLanguage(EN + " Иван Франко, Тарас Шевченко. " + EN)).toMatchObject({
      language: "en",
    });
  });
});

describe("sampleBookText", () => {
  it("uses a short book whole", () => {
    expect(sampleBookText([chapter("one"), chapter("two")])).toBe("one\n\ntwo");
  });

  it("takes a bounded sample from all over a long book", () => {
    const chapters = [
      chapter("A".repeat(150_000)),
      chapter("B".repeat(150_000)),
      chapter("C".repeat(150_000)),
    ];

    const sample = sampleBookText(chapters);

    expect(sample.length).toBeLessThanOrEqual(61_000);
    expect(sample.length).toBeGreaterThan(50_000);
    for (const letter of ["A", "B", "C"]) expect(sample).toContain(letter.repeat(1000));
  });

  it("copes with thousands of tiny chapters and with empty ones", () => {
    const chapters = Array.from({ length: 5000 }, (_, i) =>
      chapter(i % 3 === 0 ? "" : "word ".repeat(30)),
    );

    expect(sampleBookText(chapters).length).toBeLessThanOrEqual(61_000);
    expect(sampleBookText([])).toBe("");
  });
});

describe("chooseLanguage", () => {
  it("takes the language of the text when it is clear, and says it was detected", () => {
    expect(chooseLanguage(book(UK), "uk")).toMatchObject({ language: "uk", source: "detected" });
    expect(chooseLanguage(book(EN), null)).toMatchObject({ language: "en", source: "detected" });
    expect(chooseLanguage(book(RU), "ru-RU")).toMatchObject({ language: "ru", source: "detected" });
  });

  it("lets the text beat a wrong dc:language", () => {
    const choice = chooseLanguage(book(RU), "en");

    expect(choice).toMatchObject({ language: "ru", source: "detected", declared: "en" });
    expect(chooseLanguage(book(UK), "ru")).toMatchObject({ language: "uk", declared: "ru" });
  });

  it("is not thrown by a copyright page in English in front of a Ukrainian book", () => {
    const chapters = [{ text: EN.repeat(2) }, ...book(UK.repeat(4), 20)];

    expect(chooseLanguage(chapters, "en")).toMatchObject({ language: "uk", source: "detected" });
  });

  it("finds Ukrainian in a book with many English names", () => {
    const names = "Ivan Franko, Taras Shevchenko, Charles Dickens, Harry Potter, Hogwarts. ";

    expect(chooseLanguage(book(UK + names + names), "en")).toMatchObject({ language: "uk" });
  });

  it("falls back to dc:language when the text is too short to tell", () => {
    const short = [{ text: "Привіт, світе! Як ся маєш?" }];

    expect(chooseLanguage(short, "uk-UA")).toMatchObject({ language: "uk", source: "metadata" });
    expect(chooseLanguage([{ text: "Hello." }], "en_GB")).toMatchObject({
      language: "en",
      source: "metadata",
    });
    expect(chooseLanguage(short, "ru")).toMatchObject({ language: "ru", source: "metadata" });
  });

  it("says it does not know when neither the text nor dc:language help", () => {
    for (const tag of [null, "", "de", "fr-FR", "xx"]) {
      expect(chooseLanguage([{ text: "Hello." }], tag)).toEqual({
        language: "en",
        source: "unknown",
        confidence: 0,
        declared: null,
      });
    }
  });

  it("never gives an unsupported Latin-script book a confident English", () => {
    for (const tag of [null, "de", "en"]) {
      expect(chooseLanguage(book(DE), tag)).toMatchObject({ language: "en", source: "unknown" });
      expect(chooseLanguage(book(FR), tag)).toMatchObject({ source: "unknown" });
    }
  });

  it("trusts metadata that says Ukrainian or Russian for a book that is mostly Latin letters", () => {
    const chapters = book(LATIN_UK_BOOK.repeat(2));

    expect(detectLanguage(LATIN_UK_BOOK.repeat(2))).toMatchObject({
      kind: "other",
      script: "latin",
    });
    expect(chooseLanguage(chapters, "uk")).toMatchObject({ language: "uk", source: "metadata" });
    expect(chooseLanguage(chapters, "ru-RU")).toMatchObject({ language: "ru", source: "metadata" });
    // English metadata does not rescue a text that is not English, and no metadata says nothing.
    expect(chooseLanguage(chapters, "en")).toMatchObject({ source: "unknown" });
    expect(chooseLanguage(chapters, null)).toMatchObject({ source: "unknown" });
    expect(chooseLanguage(book(DE), "uk")).toMatchObject({ language: "uk", source: "metadata" });
  });

  it("does not take Bulgarian for Russian", () => {
    expect(chooseLanguage(book(BG), "ru")).toMatchObject({ source: "unknown" });
  });
});

describe("the sample books", () => {
  it("finds the Ukrainian book, whose text has English names and numbers", async () => {
    expect(await detect(ukrainianBook())).toMatchObject({ language: "uk", source: "detected" });
    expect(await detect(ukrainianBook("en"))).toMatchObject({ language: "uk", source: "detected" });
    expect(await detect(ukrainianBook(null))).toMatchObject({ language: "uk", source: "detected" });
  });

  it("finds the Russian book, also when it says it is English", async () => {
    expect(await detect(russianBook())).toMatchObject({ language: "ru", source: "detected" });
    expect(await detect(russianBook("en"))).toMatchObject({
      language: "ru",
      source: "detected",
      declared: "en",
    });
  });

  it("does not know the German book", async () => {
    expect(await detect(germanBook())).toMatchObject({ language: "en", source: "unknown" });
    expect(await detect(germanBook("en"))).toMatchObject({ language: "en", source: "unknown" });
  });

  it("finds the English book", async () => {
    expect(await detect(lighthouseBook())).toMatchObject({ language: "en", source: "detected" });
  });
});
