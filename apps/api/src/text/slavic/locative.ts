import { replaceMatches } from "../replace.js";
import type { SlavicConfig } from "./config.js";
import { alternation } from "./context.js";

/**
 * "на 5 сторінці", "у 7 класі", "в 3 комнате", "у 9-А класі": a number before a singular locative
 * noun after на, у, в, при numbers the thing, so it is an ordinal in the locative with the noun's
 * gender ("на п'ятій сторінці", "у сьомому класі", "у дев'ятому А класі").
 */
export function expandLocativeOrdinals(text: string, config: SlavicConfig): string {
  const prepositions = config.prepositions.loc.filter((word) => word !== "о" && word !== "об");
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(${alternation(prepositions)})([\s ]+)(\d{1,3})(?:-(\p{L}))?([\s ]+)(${alternation(Object.keys(config.locativeNouns))})(?![\p{L}\p{N}])`,
    "giu",
  );
  return replaceMatches(text, pattern, (m) => {
    const gender = config.locativeNouns[(m[6] as string).toLowerCase()];
    const ordinal = gender && config.numerals.ordinal(Number(m[3]), gender, "loc");
    if (!ordinal) return null;
    // A class is named with a capital letter: "9-А" is "дев'ятому А". "5-й" is an ending, left to its own rule.
    if (m[4] && m[4] === m[4].toLowerCase()) return null;
    const letter = m[4] ? ` ${m[4]}` : "";
    return `${m[1]}${m[2]}${ordinal}${letter}${m[5]}${m[6]}`;
  });
}
