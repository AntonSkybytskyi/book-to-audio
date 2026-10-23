import { LANGUAGES, MAX_WORKERS, type SettingsView } from "@book-to-audio/contracts";
import { workerTarget } from "../convert/worker-target.js";
import type { TtsCatalog } from "../tts/catalog.js";
import type { SettingsStore } from "./settings.js";

/** `GET /api/settings`: the saved settings with what each TTS service reports. */
export function settingsView(settings: SettingsStore, catalog: TtsCatalog): SettingsView {
  return {
    services: catalog.engines().map((engine) => {
      const override = settings.workersOverride(engine.id);
      return {
        id: engine.id,
        reachable: engine.reachable,
        reported: engine.ready ? engine.concurrency : 0,
        override: override ?? null,
        workers: workerTarget(engine, override),
      };
    }),
    voices: LANGUAGES.flatMap((language) => {
      const options = catalog
        .voices()
        .filter((voice) => voice.language === language)
        .map(({ id, engine, name, speaker }) => ({
          id,
          service: engine,
          name,
          ...(speaker === undefined ? {} : { speaker }),
        }));
      const chosen = settings.voice(language) ?? null;
      if (options.length === 0 && chosen === null) return [];
      return [{ language, voice: catalog.voiceFor(language)?.id ?? null, chosen, options }];
    }),
    maxWorkers: MAX_WORKERS,
    shownLanguages: settings.shownLanguages(),
  };
}
