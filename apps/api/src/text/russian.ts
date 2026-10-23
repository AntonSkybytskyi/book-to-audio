import { expandAbbreviations } from "./abbreviations.js";
import { foldLookalikes } from "./homoglyphs.js";
import { RUSSIAN_ABBREVIATIONS } from "./russian-abbreviations.js";
import { russian } from "./russian-config.js";
import { spellAgreeingNumbers } from "./slavic/agreement.js";
import { expandCurrency, expandPercent } from "./slavic/amounts.js";
import { expandCenturies } from "./slavic/centuries.js";
import { expandDates } from "./slavic/dates.js";
import { nounsRu } from "./slavic/guess-ru.js";
import {
  expandBareNumeral,
  expandHeadingNumerals,
  expandNumberedTitle,
} from "./slavic/headings.js";
import { numeralsRu } from "./slavic/numerals-ru.js";
import { joinDigitGroups, joinUsAmounts } from "./slavic/numbers.js";
import { expandRegnal } from "./slavic/regnal.js";
import { expandLocativeOrdinals } from "./slavic/locative.js";
import { expandOrdinalSuffixes } from "./slavic/suffixes.js";
import { expandYears } from "./slavic/years.js";

// espeak-ng (Piper's phonemizer) reads plain numbers in Russian, so they are left as digits
// where the digits alone are right; the rest is what it gets wrong (docs/decisions/text-processing.md).
const digits = (value: number) => String(value);

export function prepareRussian(text: string): string {
  let result = joinUsAmounts(joinDigitGroups(foldLookalikes(text, false)));
  result = expandNumberedTitle(expandBareNumeral(result, digits), digits);
  result = expandHeadingNumerals(result, russian);
  result = expandCenturies(result, russian);
  result = expandRegnal(result, russian);
  result = expandDates(result, russian);
  result = expandYears(result, russian);
  result = expandOrdinalSuffixes(expandLocativeOrdinals(result, russian), russian);
  result = expandPercent(result, russian);
  result = expandCurrency(result, russian);
  result = expandAbbreviations(result, RUSSIAN_ABBREVIATIONS);
  return spellAgreeingNumbers(result, numeralsRu, nounsRu);
}
