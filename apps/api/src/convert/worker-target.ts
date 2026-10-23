import type { SettingsStore } from "../settings/settings.js";
import type { TtsCatalog } from "../tts/catalog.js";
import type { TtsEngine } from "../tts/engine.js";

/**
 * Workers a TTS service gets: the number the owner set, else the number of requests the service
 * says it handles at once; none while it does not answer, so its chapters wait instead of failing.
 */
export const workerTarget = (
  engine: Pick<TtsEngine, "reachable" | "concurrency">,
  override: number | undefined,
): number => (engine.reachable ? (override ?? engine.concurrency) : 0);

/** `workerTarget` of a service by name: 0 for a service that is not configured. */
export const workersOf =
  (
    catalog: Pick<TtsCatalog, "engine">,
    settings: Pick<SettingsStore, "workersOverride">,
  ): ((service: string) => number) =>
  (service) => {
    const engine = catalog.engine(service);
    return engine ? workerTarget(engine, settings.workersOverride(service)) : 0;
  };

/**
 * A service's workers, and the most sessions worth comparing on it in the speed test: what the
 * service handles at once, or the worker count when the owner set it higher.
 */
export const benchmarkWorkersOf =
  (
    catalog: Pick<TtsCatalog, "engine">,
    settings: Pick<SettingsStore, "workersOverride">,
  ): ((service: string) => { current: number; max: number }) =>
  (service) => {
    const current = workersOf(catalog, settings)(service);
    return { current, max: Math.max(1, current, catalog.engine(service)?.concurrency ?? 1) };
  };
