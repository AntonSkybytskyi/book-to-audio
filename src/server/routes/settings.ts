import type { FastifyInstance } from "fastify";
import { LANGUAGES, type Language } from "../books/languages.js";
import type { PoolControl } from "../convert/pool.js";
import type { SettingsStore } from "../settings/settings.js";
import { sendError } from "./errors.js";

export interface SettingsRouteDeps {
  settings: SettingsStore;
  pool: Pick<PoolControl, "setWorkers">;
}

/** `GET` and `PATCH /api/settings`. Only the fields in the body change. */
export function registerSettingsRoutes(
  api: FastifyInstance,
  { settings, pool }: SettingsRouteDeps,
) {
  api.get("/settings", async () => settings.view());

  api.patch<{ Body: { workers?: number; shownLanguages?: Language[] } }>(
    "/settings",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            workers: { type: "integer", minimum: 1, maximum: settings.maxWorkers },
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
      if (req.body.shownLanguages) settings.setShownLanguages(req.body.shownLanguages);
      if (req.body.workers !== undefined) {
        settings.setWorkers(req.body.workers);
        pool.setWorkers(settings.workers());
      }
      return settings.view();
    },
  );
}
