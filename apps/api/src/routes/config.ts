import type { FastifyInstance } from "fastify";

/** `GET /api/config`: settings the UI needs to behave like the server. */
export function registerConfigRoute(api: FastifyInstance, options: { maxUploadBytes: number }) {
  const maxUploadMb = Math.round(options.maxUploadBytes / (1024 * 1024));
  api.get("/config", async () => ({ maxUploadMb }));
}
