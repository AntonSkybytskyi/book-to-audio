import fs from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { BookRepository } from "../books/repository.js";
import type { Storage } from "../books/storage.js";
import { loadBookView } from "../books/views.js";
import { sendFile } from "../http/send-file.js";
import type { OutputBuilder } from "../outputs/builder.js";
import { asciiDownloadName, contentDisposition, downloadFileName } from "../outputs/names.js";
import { toOutputsView, type OutputsView } from "../outputs/view.js";
import type { Estimator } from "../speed/estimator.js";
import type { TtsCatalog } from "../tts/catalog.js";
import { sendError } from "./errors.js";

export interface DownloadRouteDeps {
  repo: BookRepository;
  storage: Storage;
  catalog: TtsCatalog;
  outputs: Pick<OutputBuilder, "request" | "filesMissing">;
  estimator: Estimator;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONTENT_TYPES = { m4b: "audio/mp4", zip: "application/zip" } as const;

/** Why there is nothing to download yet, in words for the owner. */
function notReady(bookDone: boolean, outputs: OutputsView): string {
  if (!bookDone) return "The downloads are ready when every chapter is done.";
  if (outputs.state === "failed")
    return "The downloads could not be built. Try building them again.";
  if (outputs.updating) return "The downloads are being updated after a chapter changed.";
  return "The downloads are still being prepared.";
}

/**
 * `GET /books/:id/downloads/m4b` and `/zip`, and `POST /books/:id/outputs/rebuild`. A download is
 * only served while it was built from the book's current audio and the book is done (409 otherwise).
 */
export function registerDownloadRoutes(api: FastifyInstance, deps: DownloadRouteDeps) {
  const { repo, storage, catalog, outputs, estimator } = deps;

  const withBook = (id: string, reply: FastifyReply) => {
    if (!UUID.test(id)) {
      sendError(reply, 400, "invalid_id", "The book id is not valid.");
      return null;
    }
    const book = repo.get(id);
    if (!book) sendError(reply, 404, "not_found", "There is no book with this id.");
    return book ?? null;
  };

  for (const kind of ["m4b", "zip"] as const) {
    api.get<{ Params: { id: string } }>(`/books/:id/downloads/${kind}`, async (req, reply) => {
      const book = withBook(req.params.id, reply);
      if (!book) return reply;
      const view = toOutputsView(book.status, book.audioGeneration, book.outputs);
      if (!view.available) {
        return sendError(reply, 409, "not_ready", notReady(book.status === "done", view));
      }
      const present = (["m4b", "zip"] as const).every((k) =>
        fs.existsSync(storage.outputFile(book.id, k)),
      );
      if (!present) {
        // Recorded as built but gone from the disk: stop offering it and build it again, instead of failing for good.
        outputs.filesMissing(book.id);
        return sendError(reply, 409, "not_ready", "The file is missing. It is being built again.");
      }
      reply.header(
        "Content-Disposition",
        contentDisposition(downloadFileName(kind, book), asciiDownloadName(kind, book)),
      );
      return sendFile(req, reply, storage.outputFile(book.id, kind), CONTENT_TYPES[kind]);
    });
  }

  api.post<{ Params: { id: string } }>("/books/:id/outputs/rebuild", async (req, reply) => {
    const book = withBook(req.params.id, reply);
    if (!book) return reply;
    const state = book.outputs?.state;
    if (book.status !== "done") {
      return sendError(
        reply,
        409,
        "conflict",
        "The downloads can only be built for a finished book.",
      );
    }
    if (state === "queued" || state === "building") {
      return sendError(reply, 409, "conflict", "The downloads are already being built.");
    }
    outputs.request(book.id, { force: true });
    return loadBookView(repo, catalog, estimator, book.id);
  });
}
