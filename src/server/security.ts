import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const UNSAFE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Headers for JSON, images and audio from `/api`. Next.js pages get theirs in next.config.ts. */
export const API_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
} as const;

/** `localhost:3000` becomes `localhost`, `[::1]:3000` becomes `[::1]`. */
export function hostname(host: string): string {
  const lower = host.trim().toLowerCase();
  if (lower.startsWith("[")) return lower.slice(0, lower.indexOf("]") + 1);
  return lower.split(":")[0] ?? "";
}

const forbidden = (reply: FastifyReply, message: string) =>
  reply.code(403).send({ error: "forbidden", message });

/**
 * Keeps other websites from using the app through the owner's browser.
 *
 * - The `Host` header must be a local name (or one listed in `ALLOWED_HOSTS`),
 *   which stops DNS rebinding: a hostile site pointing its own name at 127.0.0.1.
 * - Requests that change something must come from this origin. A cross-origin
 *   `<form>` can send a multipart POST without any CORS preflight.
 */
export function registerHostAndOriginGuard(app: FastifyInstance, extraHosts: readonly string[]) {
  const allowed = new Set([...LOCAL_HOSTS, ...extraHosts.map((h) => h.toLowerCase())]);

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const host = req.headers.host;
    if (!host || !allowed.has(hostname(host))) {
      return forbidden(reply, "This address is not allowed. Open the app at http://localhost.");
    }
    if (!UNSAFE_METHODS.has(req.method)) return;

    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      return forbidden(reply, "Requests from other sites are not allowed.");
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        // "null" and other junk fall through to the rejection below.
      }
      if (originHost !== host.toLowerCase()) {
        return forbidden(reply, "Requests from other sites are not allowed.");
      }
    }
  });
}
