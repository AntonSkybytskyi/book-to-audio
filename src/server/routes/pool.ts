import type { FastifyInstance } from "fastify";
import type { PoolControl } from "../convert/pool.js";

/** `GET /api/pool` and `POST /api/pool/resume`. */
export function registerPoolRoutes(api: FastifyInstance, pool: PoolControl) {
  api.get("/pool", async () => pool.status());
  // Resuming a pool that is not paused changes nothing and still answers 200.
  api.post("/pool/resume", async () => pool.resume());
}
