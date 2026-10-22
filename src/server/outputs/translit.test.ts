import { describe, expect, it } from "vitest";
import { transliterate } from "./translit.js";

describe("transliterate", () => {
  it("spells Ukrainian the way the national system does", () => {
    expect(transliterate("Тіні забутих предків")).toBe("Tini zabutykh predkiv");
    expect(transliterate("Коцюбинський")).toBe("Kotsiubynskyi");
    expect(transliterate("Щастя їжак")).toBe("Shchastia yizhak");
    expect(transliterate("Євген Юрій Ярослав")).toBe("Yevhen Yurii Yaroslav");
    expect(transliterate("Україна ґанок")).toBe("Ukraina ganok");
  });

  it("spells Russian its own way for a Russian book, and drops the soft and hard signs", () => {
    expect(transliterate("Война и мир", "ru")).toBe("Voyna i mir");
    expect(transliterate("Объект ёлка Жизнь Юрий", "ru")).toBe("Obekt yolka Zhizn Yuriy");
    expect(transliterate("Пётр Гоголь", "ru")).toBe("Pyotr Gogol");
    expect(transliterate("Война и мир")).toBe("Voina y myr");
  });

  it("capitalises a letter that becomes several", () => {
    expect(transliterate("ЖЩЧ Ш")).toBe("ZhShchCh Sh");
  });

  it("spells Latin letters that have no accent to drop, and leaves the rest alone", () => {
    expect(transliterate("Straße Ærø Łódź")).toBe("Strasse Aero Lódź");
    expect(transliterate("Hello, 世界 42!")).toBe("Hello, 世界 42!");
  });
});
