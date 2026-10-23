/**
 * The default Piper voice of each language (docs/decisions/voices.md). A language's voice is the
 * first one `voices()` lists, so these models come first even when others sit in the voices folder.
 */
export const DEFAULT_PIPER_VOICES: Readonly<Record<string, { model: string; speaker?: string }>> = {
  en: { model: "en_US-lessac-medium" },
  // One model with three speakers; this is the one the voice is read by.
  uk: { model: "uk_UA-ukrainian_tts-medium", speaker: "lada" },
  ru: { model: "ru_RU-ruslan-medium" },
};

const PREFERRED_MODELS = new Set(Object.values(DEFAULT_PIPER_VOICES).map((v) => v.model));

/** The speaker to use for a multi-speaker model: the chosen default, else the first one. */
export function defaultSpeaker(
  model: string,
  speakers: Readonly<Record<string, number>>,
): { id: number; name: string } | null {
  const wanted = Object.values(DEFAULT_PIPER_VOICES).find((v) => v.model === model)?.speaker;
  if (wanted !== undefined) {
    const id = speakers[wanted];
    // A model that no longer has the speaker is not used: another speaker would change the voice.
    return id === undefined ? null : { id, name: wanted };
  }
  const first = Object.entries(speakers).toSorted(([, a], [, b]) => a - b)[0];
  return first ? { id: first[1], name: first[0] } : { id: 0, name: "0" };
}

/** Default models first, the rest by name (code units, so the order is the same on every machine). */
export const compareVoiceFiles = (a: string, b: string): number =>
  Number(PREFERRED_MODELS.has(b)) - Number(PREFERRED_MODELS.has(a)) || (a < b ? -1 : a > b ? 1 : 0);
