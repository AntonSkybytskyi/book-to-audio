/**
 * Replaces the matches of a global `pattern` with what `fn` returns; a null leaves the match as
 * it is. `fn` also gets the whole text, to look at what comes before the match.
 */
export function replaceMatches(
  text: string,
  pattern: RegExp,
  fn: (match: RegExpExecArray, text: string) => string | null,
): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const replacement = fn(match, text);
    if (replacement === null) continue;
    out += text.slice(last, match.index) + replacement;
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
}

/** The word right before `index`, lowercase, or "" (`"в 1999"` before the 1 gives "в"). */
export function previousWord(text: string, index: number): string {
  const before = text.slice(Math.max(0, index - 40), index);
  return /(\p{L}+)[\s\u00A0]*$/u.exec(before)?.[1]?.toLowerCase() ?? "";
}

/** The first word at or after `index` (skipping spaces), lowercase, or "". */
export function nextWord(text: string, index: number): string {
  return /^[\s\u00A0]*(\p{L}+)/u.exec(text.slice(index, index + 40))?.[1]?.toLowerCase() ?? "";
}
