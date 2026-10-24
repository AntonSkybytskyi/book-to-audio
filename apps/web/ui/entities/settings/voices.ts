import type { LanguageVoiceView } from "@book-to-audio/contracts";

/** What the Settings page says under a language's voice, or null when the chosen voice reads it. */
export function voiceNote({ voice, chosen, options }: LanguageVoiceView): string | null {
  if (voice === null) {
    return "Its speech service has not answered yet; books in this language wait for it.";
  }
  if (chosen === null || voice === chosen) return null;
  const name = options.find((option) => option.id === voice)?.name ?? voice;
  return `The chosen voice is not available now, so ${name} reads this language until it is back.`;
}
