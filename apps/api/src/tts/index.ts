import type { Config } from "../config.js";
import { TtsCatalog, type TtsCatalogOptions } from "./catalog.js";
import { HttpTtsEngine } from "./http-engine.js";

/** The TTS services of `TTS_SERVICES`, in that order. */
export function createCatalog(
  config: Pick<Config, "ttsServices" | "ttsRequestTimeoutMs">,
  options: TtsCatalogOptions = {},
): TtsCatalog {
  const engines = config.ttsServices.map(
    ({ name, url }) =>
      new HttpTtsEngine({ id: name, baseUrl: url, requestTimeoutMs: config.ttsRequestTimeoutMs }),
  );
  return new TtsCatalog(engines, options);
}
