import { expandAbbreviations } from "./abbreviations.js";
import { foldLookalikes } from "./homoglyphs.js";
import { expandCenturies } from "./slavic/centuries.js";
import { expandDates } from "./slavic/dates.js";
import {
  expandBareNumeral,
  expandHeadingNumerals,
  expandNumberedTitle,
} from "./slavic/headings.js";
import {
  expandCurrency,
  expandHourLocative,
  expandPercent,
  expandTimes,
} from "./slavic/amounts.js";
import { joinDigitGroups, joinUsAmounts } from "./slavic/numbers.js";
import { expandRegnal } from "./slavic/regnal.js";
import { expandLocativeOrdinals } from "./slavic/locative.js";
import { expandOrdinalSuffixes } from "./slavic/suffixes.js";
import { expandYears } from "./slavic/years.js";
import { UKRAINIAN_ABBREVIATIONS } from "./ukrainian-abbreviations.js";
import { restrictToVoiceAlphabet } from "./ukrainian-alphabet.js";
import { ukrainian } from "./ukrainian-config.js";
import { transliterateLatin } from "./ukrainian-latin.js";
import { spellRemainingNumbers } from "./ukrainian-numbers.js";

const spell = (value: number) => ukrainian.numerals.cardinal(value);

/**
 * Ukrainian text for the character-based voice, which cannot read digits or Latin letters: the
 * cases that can be told are declined (years, dates, centuries, chapters, percent, money, the
 * genitive after "до" and "від"), the rest of the numbers are spelled as nominative cardinals.
 */
export function prepareUkrainian(text: string): string {
  let result = joinUsAmounts(joinDigitGroups(foldLookalikes(text, true)));
  result = expandNumberedTitle(expandBareNumeral(result, spell), spell);
  result = expandHeadingNumerals(result, ukrainian);
  result = expandCenturies(result, ukrainian);
  result = expandRegnal(result, ukrainian);
  result = expandDates(result, ukrainian);
  result = expandYears(result, ukrainian);
  result = expandOrdinalSuffixes(expandLocativeOrdinals(result, ukrainian), ukrainian);
  result = expandPercent(result, ukrainian);
  result = expandCurrency(result, ukrainian);
  result = expandHourLocative(result, ukrainian);
  result = expandTimes(result, ukrainian);
  result = expandAbbreviations(result, UKRAINIAN_ABBREVIATIONS);
  result = spellRemainingNumbers(result);
  return restrictToVoiceAlphabet(transliterateLatin(result));
}
