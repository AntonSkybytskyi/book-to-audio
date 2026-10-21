import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { languageFromTag } from "../books/languages.js";
import { countWords } from "../books/estimate.js";
import type { BookRepository } from "../books/repository.js";
import type { Storage } from "../books/storage.js";
import { loadBookView } from "../books/views.js";
import type { EventBus } from "../events/bus.js";
import { EpubError } from "../epub/errors.js";
import { ParserBusyError } from "../epub/worker-parser.js";
import type { ParsedEpub } from "../epub/types.js";
import { sendError } from "./errors.js";
import type { TtsEngine } from "../tts/engine.js";

export interface UploadDeps {
  repo: BookRepository;
  storage: Storage;
  engine: TtsEngine;
  bus: EventBus;
  /** Parses the stored upload. Reads the file itself, so the server never holds it in memory. */
  parseEpub: (filePath: string) => Promise<ParsedEpub>;
}

/** Carries the code that the API error handler maps to a 413 response. */
class UploadTooLargeError extends Error {
  readonly code = "FST_REQ_FILE_TOO_LARGE";
  readonly statusCode = 413;

  constructor() {
    super("The file is larger than the upload limit.");
  }
}

const STATUS_BY_EPUB_ERROR: Record<EpubError["code"], number> = {
  not_epub: 422,
  drm: 422,
  no_chapters: 422,
  unsafe_archive: 422,
  too_many_chapters: 422,
};

/** `POST /api/books`: stores the upload, parses it and returns the new book. */
export function registerUpload(
  api: FastifyInstance,
  { repo, storage, engine, bus, parseEpub }: UploadDeps,
) {
  api.post("/books", async (req, reply) => {
    if (!req.isMultipart()) {
      return sendError(reply, 415, "unsupported_type", "Upload the file as multipart/form-data.");
    }
    const part = await req.file();
    if (!part) return sendError(reply, 400, "bad_request", "No file was uploaded.");
    if (part.fieldname !== "file") {
      part.file.resume();
      return sendError(reply, 400, "bad_request", 'Send the book in a form field named "file".');
    }
    if (!part.filename.toLowerCase().endsWith(".epub")) {
      part.file.resume();
      return sendError(reply, 415, "unsupported_type", "Only .epub files are supported for now.");
    }

    const id = randomUUID();
    try {
      storage.ensureBookDir(id);
      const sourcePath = storage.sourceRelPath(id);
      // The size limit is enforced by the stream: the file is cut off and the pipeline fails.
      await pipeline(part.file, fs.createWriteStream(storage.resolve(sourcePath), { mode: 0o600 }));
      if (part.file.truncated) throw new UploadTooLargeError();

      const parsed = await parseEpub(storage.resolve(sourcePath));

      let coverPath: string | null = null;
      if (parsed.cover) {
        coverPath = storage.coverRelPath(id, parsed.cover.mime);
        if (coverPath) await fs.promises.writeFile(storage.resolve(coverPath), parsed.cover.bytes);
      }

      repo.insert(
        {
          id,
          title: parsed.title,
          author: parsed.author,
          language: languageFromTag(parsed.language),
          coverMime: coverPath ? (parsed.cover?.mime ?? null) : null,
          coverPath,
          sourcePath,
        },
        parsed.chapters.map((c) => ({
          title: c.title,
          text: c.text,
          wordCount: countWords(c.text),
        })),
      );
    } catch (error) {
      storage.removeBookFiles(id);
      if (error instanceof ParserBusyError) {
        return sendError(reply, 429, "busy", error.message);
      }
      if (error instanceof EpubError) {
        return sendError(reply, STATUS_BY_EPUB_ERROR[error.code], error.code, error.message);
      }
      throw error; // Size limits and everything unexpected go to the error handler.
    }

    const view = loadBookView(repo, engine, id);
    if (!view) throw new Error("book vanished after insert");
    bus.publish({ type: "book-added", bookId: id });
    return reply.code(201).send(view);
  });
}
