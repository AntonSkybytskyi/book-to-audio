const SPACE_LIKE = /[()[\]{}/\\|*_#@~^<>=+&§©®™°%$€£]/g;

/**
 * The letters the voice can read: other characters are removed or become spaces, so they do not
 * glue the words around them together ("він/вона"). Quotes disappear; dashes and the ellipsis
 * become the ones the voice knows.
 */
export function restrictToVoiceAlphabet(text: string): string {
  return (
    text
      .replace(/[‘’ʼ`´]/g, "'")
      .replace(/…/g, "...")
      .replace(/[‒–―]/g, "—")
      .replace(/[«»“”„‟"]/g, "")
      .replace(/№\s*/g, "номер ")
      .replace(/ё/g, "йо")
      .replace(/Ё/g, "Йо")
      // A bracket is a pause: "Тарас Шевченко (1814–1861) народився" gets commas around the years.
      .replace(/\s*[([{]\s*/g, ", ")
      .replace(/\s*[)\]}]\s*/g, ", ")
      .replace(/[ыЫ]/g, (c) => (c === "ы" ? "и" : "И"))
      .replace(/[эЭ]/g, (c) => (c === "э" ? "е" : "Е"))
      .replace(/[ъЪ]/g, "")
      .replace(SPACE_LIKE, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/ +([.,;:!?])/g, "$1")
      .replace(/,(?:\s*,)+/g, ",")
      .replace(/,\s*([.;:!?])/g, "$1")
      .replace(/^[,\s]+/, "")
      .replace(/[,\s]+$/, (tail) => (tail.includes(",") ? "" : tail))
      .trim()
  );
}
