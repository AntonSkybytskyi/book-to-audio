import { MAX_WORKERS, type SettingsView } from "@book-to-audio/contracts";
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
    maxWorkers: MAX_WORKERS,
    shownLanguages: settings.shownLanguages(),
  };
}
