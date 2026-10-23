import { buildSampleBook } from "./sample-books.js";
import { makeCover } from "./png.js";

// Small books in other languages for the language detection and the text rules. The excerpts
// are public domain (Shevchenko, Chekhov, the Brothers Grimm); the paragraphs with numbers,
// abbreviations and Latin names were written for the tests.

const paragraphs = (...texts: string[]) => texts.map((t) => `<p>${t}</p>`).join("\n");

/** Ukrainian, EPUB 3: a poem, a chapter of dates and abbreviations, and one of centuries and English names. */
export function ukrainianBook(language: string | null = "uk"): Promise<Buffer> {
  return buildSampleBook({
    version: 3,
    toc: "nav",
    title: "Заповіт та інші сторінки",
    author: "Тарас Шевченко",
    language,
    cover: makeCover([30, 74, 124], [244, 214, 96]),
    chapters: [
      {
        file: "uk1",
        title: "I. Заповіт",
        body:
          "<h1>I. Заповіт</h1>" +
          paragraphs(
            "Як умру, то поховайте<br/>Мене на могилі,<br/>Серед степу широкого,<br/>На Вкраїні милій,",
            "Щоб лани широкополі,<br/>І Дніпро, і кручі<br/>Було видно, було чути,<br/>Як реве ревучий.",
          ),
      },
      {
        file: "uk2",
        title: "II. Рік 1861",
        body:
          "<h1>II. Рік 1861</h1>" +
          paragraphs(
            "Тарас Шевченко народився 9 березня 1814 р. у селі Моринці. У 1861 році, 10 березня, його не стало, і він прожив усього 47 років.",
            "Про це пишуть у книжках, що вийшли до 2014 року, і т. д. Див. також розділ IV. Видання коштувало 5 грн. або 12,50 грн., а передплата подорожчала на 15%.",
          ),
      },
      {
        file: "uk3",
        title: "XIX століття",
        body:
          "<h1>XIX століття</h1>" +
          paragraphs(
            "У XIX столітті «Кобзар» виходив кількома виданнями. На початку XX століття його читали вже в м. Києві та в м. Львові, о 10:30 ранку або о 9:05 вечора.",
            "Серед гостей були Ivan Franko, Taras Shevchenko і Charles Dickens, а за 3 роки до того в 21-му виданні з'явилося 2 статті та 1 000 000 слів, і ще 3-го червня.",
          ),
      },
    ],
  });
}

/** Russian, EPUB 2: two Chekhov openings and a chapter of numbers, abbreviations and Roman numerals. */
export function russianBook(language: string | null = "ru"): Promise<Buffer> {
  return buildSampleBook({
    version: 2,
    toc: "ncx",
    title: "Рассказы",
    author: "Антон Чехов",
    language,
    cover: makeCover([96, 48, 40], [232, 220, 196]),
    chapters: [
      {
        file: "ru1",
        title: "I. Хамелеон",
        body:
          "<h2>I. Хамелеон</h2>" +
          paragraphs(
            "Через базарную площадь идет полицейский надзиратель Очумелов в новой шинели и с узелком в руке. За ним шагает рыжий городовой с решетом, доверху наполненным конфискованным крыжовником. Кругом тишина... Ни души... Открытые двери лавок и кабаков глядят на свет божий уныло, как голодные пасти; около них нет даже нищих.",
          ),
      },
      {
        file: "ru2",
        title: "II. Смерть чиновника",
        body:
          "<h2>II. Смерть чиновника</h2>" +
          paragraphs(
            "В один прекрасный вечер не менее прекрасный экзекутор, Иван Дмитрич Червяков, сидел во втором ряду кресел и глядел в бинокль на «Корневильские колокола». Он глядел и ощущал себя на верху блаженства. Но вдруг... В рассказах часто встречается это «но вдруг». Авторы правы: жизнь так полна внезапностей!",
          ),
      },
      {
        file: "ru3",
        title: "XIX век",
        body:
          "<h2>XIX век</h2>" +
          paragraphs(
            "Антон Павлович Чехов родился 29 января 1860 г. в Таганроге, а умер в 1904 г. Это конец XIX в. и начало XX века. В 1890 году он поехал на Сахалин, т. е. проделал путь в 10 000 вёрст.",
            "Билет стоил 21 руб. 50 коп., цены выросли на 15%, а в г. Москве его ждали к 10:30. Глава IV. Читайте об этом в 3-м томе, см. рис. 3.",
          ),
      },
    ],
  });
}

/** German (not supported): the start of "Der Froschkönig" by the Brothers Grimm. */
export function germanBook(language: string | null = "de"): Promise<Buffer> {
  return buildSampleBook({
    version: 3,
    toc: "nav",
    title: "Der Froschkönig",
    author: "Brüder Grimm",
    language,
    chapters: [
      {
        file: "de1",
        title: "Der Wald",
        body: paragraphs(
          "In den alten Zeiten, wo das Wünschen noch geholfen hat, lebte ein König, dessen Töchter waren alle schön, aber die jüngste war so schön, dass die Sonne selbst, die doch so vieles gesehen hat, sich verwunderte, sooft sie ihr ins Gesicht schien.",
          "Nahe bei dem Schlosse des Königs lag ein großer dunkler Wald, und in dem Walde unter einer alten Linde war ein Brunnen.",
        ),
      },
      {
        file: "de2",
        title: "Die goldene Kugel",
        body: paragraphs(
          "Wenn nun der Tag recht heiß war, so ging das Königskind hinaus in den Wald und setzte sich an den Rand des kühlen Brunnens, und wenn sie Langeweile hatte, so nahm sie eine goldene Kugel, warf sie in die Höhe und fing sie wieder; und das war ihr liebstes Spielzeug.",
          "Nun trug es sich einmal zu, dass die goldene Kugel der Königstochter nicht in ihr Händchen fiel, sondern auf die Erde schlug und geradezu ins Wasser hineinrollte.",
        ),
      },
    ],
  });
}
