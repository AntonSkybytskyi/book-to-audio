import { MAX_WORKERS, type SettingsPatch } from "@book-to-audio/contracts";
import type { FastifyInstance } from "fastify";
import { LANGUAGES, type Language } from "../books/languages.js";
import type { PoolControl } from "../convert/pool.js";
import type { SettingsStore } from "../settings/settings.js";
import { settingsView } from "../settings/view.js";
import type { TtsCatalog } from "../tts/catalog.js";
import { sendError } from "./errors.js";

export interface SettingsRouteDeps {
  settings: SettingsStore;
  catalog: TtsCatalog;
  pool: Pick<PoolControl, "refreshWorkers" | "notify">;
}

/** `GET` and `PATCH /api/settings`. Only the fields in the body change. */
export function registerSettingsRoutes(
  api: FastifyInstance,
  { settings, catalog, pool }: SettingsRouteDeps,
) {
  const services = catalog.engines().map((engine) => engine.id);

  api.get("/settings", async () => settingsView(settings, catalog));

  api.patch<{ Body: SettingsPatch }>(
    "/settings",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            // One entry per configured service; null goes back to the number the service reports.
            workers: {
              type: "object",
              additionalProperties: false,
              minProperties: 1,
              properties: Object.fromEntries(
                services.map((id) => [
                  id,
                  { type: ["integer", "null"], minimum: 1, maximum: MAX_WORKERS },
                ]),
              ),
            },
            // null goes back to the default voice; whether the voice exists is checked below.
            voices: {
              type: "object",
              additionalProperties: false,
              minProperties: 1,
              properties: Object.fromEntries(
                LANGUAGES.map((language) => [language, { type: ["string", "null"], minLength: 1 }]),
              ),
            },
            // An empty list is answered below, in words the settings page can show as they are.
            shownLanguages: {
              type: "array",
              uniqueItems: true,
              maxItems: LANGUAGES.length,
              items: { type: "string", enum: [...LANGUAGES] },
            },
          },
        },
      },
    },
    (req, reply) => {
      if (req.body.shownLanguages?.length === 0) {
        return sendError(
          reply,
          400,
          "bad_request",
          "At least one language has to stay shown. Turn another one on first.",
        );
      }
      const voices = Object.entries(req.body.voices ?? {}) as [Language, string | null][];
      for (const [language, id] of voices) {
        if (id !== null && catalog.voice(id)?.language !== language) {
          return sendError(
            reply,
            400,
            "bad_request",
            `There is no ${language} voice "${id}". Pick one of the voices listed.`,
          );
        }
      }
      if (req.body.shownLanguages) settings.setShownLanguages(req.body.shownLanguages);
      if (voices.length > 0) {
        for (const [language, id] of voices) settings.setVoice(language, id);
        // The next chapter of the language may belong to another service's workers now.
        pool.refreshWorkers();
        pool.notify();
      }
      if (req.body.workers) {
        for (const [service, count] of Object.entries(req.body.workers)) {
          settings.setWorkersOverride(service, count);
        }
        pool.refreshWorkers();
      }
      return settingsView(settings, catalog);
    },
  );
}
