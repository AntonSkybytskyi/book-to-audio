import type { FastifyInstance } from "fastify";
import type { PoolControl } from "../convert/pool.js";
import type { SettingsStore } from "../settings/settings.js";

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

  api.patch<{ Body: { workers?: number } }>(
    "/settings",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: { workers: { type: "integer", minimum: 1, maximum: settings.maxWorkers } },
        },
      },
    },
    (req) => {
      if (req.body.workers !== undefined) {
        settings.setWorkers(req.body.workers);
        pool.setWorkers(settings.workers());
      }
      return settings.view();
    },
  );
}
