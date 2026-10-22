/** "1 000 000" and "12 345,6" as one number: groups of three digits after a space (at most 4 groups). */
export function joinDigitGroups(text: string): string {
  return text.replace(
    /(?<![\d.,])(\d{1,3})((?: \d{3}){1,4})(?!\d)/g,
    (_, head: string, rest: string) => head + rest.replaceAll(" ", ""),
  );
}

/** "$1,200.50" is written with a comma for thousands: the commas go, so that it is one amount. */
export function joinUsAmounts(text: string): string {
  return text.replace(
    /([$€£][\s\u00A0]?)(\d{1,3}(?:,\d{3}){1,4})(?!\d)/g,
    (_, symbol: string, digits: string) => symbol + digits.replaceAll(",", ""),
  );
}
