import type { FastifyInstance } from "fastify";
import type { PoolControl } from "../convert/pool.js";

/**
 * `GET /api/pool` and `POST /api/pool/resume`, which resumes everything, or with `{ service }` only
 * that TTS service's workers.
 */
export function registerPoolRoutes(api: FastifyInstance, pool: PoolControl) {
  api.get("/pool", async () => pool.status());
  // Resuming a pool that is not paused changes nothing and still answers 200.
  api.post<{ Body: { service?: string } | undefined }>(
    "/pool/resume",
    {
      schema: {
        body: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: { service: { type: "string", minLength: 1 } },
        },
      },
    },
    (req, reply) => reply.send(pool.resume(req.body?.service ?? undefined)),
  );
}
