import fs from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { parseRange } from "./range.js";

/**
 * Sends a file with `Range` support. Browsers (Safari in particular) need
 * 206 responses to play and seek audio.
 */
export async function sendFile(
  req: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  contentType: string,
) {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return reply.code(404).send({ error: "not_found", message: "The file is missing." });
  }

  const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  reply
    .header("Content-Type", contentType)
    .header("Accept-Ranges", "bytes")
    .header("ETag", etag)
    .header("Cache-Control", "no-cache")
    .header("X-Content-Type-Options", "nosniff");

  if (req.headers["if-none-match"] === etag) return reply.code(304).send();

  // A client resuming a download of an older version of the file gets the whole new one.
  const ifRange = req.headers["if-range"];
  const range =
    ifRange !== undefined && ifRange !== etag ? null : parseRange(req.headers.range, stat.size);
  if (range === "unsatisfiable") {
    return reply.code(416).header("Content-Range", `bytes */${stat.size}`).send();
  }
  if (range === null) {
    return reply.header("Content-Length", stat.size).send(fs.createReadStream(filePath));
  }
  return reply
    .code(206)
    .header("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`)
    .header("Content-Length", range.end - range.start + 1)
    .send(fs.createReadStream(filePath, { start: range.start, end: range.end }));
}
