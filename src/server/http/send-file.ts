import fs from "node:fs";
import fsp from "node:fs/promises";
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
  // One open file for the size and for the bytes: a rename that lands in between (a download
  // rebuilt, a chapter replaced) cannot make the length and the body come from different files.
  let handle: fsp.FileHandle;
  let stat: fs.Stats;
  try {
    handle = await fsp.open(filePath, "r");
    try {
      stat = await handle.stat();
      if (!stat.isFile()) throw new Error("not a file");
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch {
    return reply.code(404).send({ error: "not_found", message: "The file is missing." });
  }
  const finished = async (answer: FastifyReply) => {
    await handle.close();
    return answer;
  };

  const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
  reply
    .header("Content-Type", contentType)
    .header("Accept-Ranges", "bytes")
    .header("ETag", etag)
    .header("Cache-Control", "no-cache")
    .header("X-Content-Type-Options", "nosniff");

  if (req.headers["if-none-match"] === etag) return finished(reply.code(304).send());

  // A client resuming a download of an older version of the file gets the whole new one.
  const ifRange = req.headers["if-range"];
  const range =
    ifRange !== undefined && ifRange !== etag ? null : parseRange(req.headers.range, stat.size);
  if (range === "unsatisfiable") {
    return finished(reply.code(416).header("Content-Range", `bytes */${stat.size}`).send());
  }
  if (range === null) {
    return reply.header("Content-Length", stat.size).send(handle.createReadStream());
  }
  return reply
    .code(206)
    .header("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`)
    .header("Content-Length", range.end - range.start + 1)
    .send(handle.createReadStream({ start: range.start, end: range.end }));
}
