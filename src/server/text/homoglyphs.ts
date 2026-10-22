/** Latin letters that look like Cyrillic ones; books that went through OCR are full of them. */
const LOOKALIKES: Record<string, string> = {
  A: "А",
  B: "В",
  C: "С",
  E: "Е",
  H: "Н",
  K: "К",
  M: "М",
  O: "О",
  P: "Р",
  T: "Т",
  X: "Х",
  a: "а",
  c: "с",
  e: "е",
  o: "о",
  p: "р",
  x: "х",
  y: "у",
};

/**
 * Inside a word that has Cyrillic letters, Latin look-alikes are Cyrillic ones ("Cкоро" typed with
 * a Latin C): they are mapped before anything else reads the word, so it is not respelled as
 * English. `i` and `I` become the Ukrainian і and І only in Ukrainian text.
 */
export function foldLookalikes(text: string, ukrainian: boolean): string {
  return text.replace(/[\p{L}\p{M}]+/gu, (word) => {
    if (!/\p{Script=Cyrillic}/u.test(word) || !/\p{Script=Latin}/u.test(word)) return word;
    return [...word]
      .map((letter) => {
        if (ukrainian && letter === "i") return "і";
        if (ukrainian && letter === "I") return "І";
        return LOOKALIKES[letter] ?? letter;
      })
      .join("");
  });
}
