import type { FastifyInstance, FastifyReply } from "fastify";
import type { BookListView } from "@book-to-audio/contracts";
import { LANGUAGES, type Language } from "../books/languages.js";
import type { BookRepository } from "../books/repository.js";
import type { Storage } from "../books/storage.js";
import type { PreparedCounter } from "../books/prepared-counter.js";
import { loadBookView, loadSummaries } from "../books/views.js";
import type { EventBus } from "../events/bus.js";
import { sendFile } from "../http/send-file.js";
import type { PoolControl } from "../convert/pool.js";
import type { Estimator } from "../speed/estimator.js";
import type { TtsCatalog } from "../tts/catalog.js";
import { sendError } from "./errors.js";

export interface BookRouteDeps {
  repo: BookRepository;
  storage: Storage;
  catalog: TtsCatalog;
  bus: EventBus;
  /** Wakes idle workers after a book is queued. */
  pool: Pick<PoolControl, "notify">;
  estimator: Estimator;
  /** Counts the prepared characters again, in the background, when the language changes. */
  counter: Pick<PreparedCounter, "enqueue">;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LANGUAGE_NAMES: Record<Language, string> = { en: "English", uk: "Ukrainian", ru: "Russian" };

export function registerBookRoutes(api: FastifyInstance, deps: BookRouteDeps) {
  const { repo, storage, catalog, bus, pool, estimator, counter } = deps;

  const bookView = (id: string) => loadBookView(repo, catalog, estimator, id);

  /** Validates `:id` and loads the book, replying 400 or 404 itself when it cannot. */
  const withBook = (id: string, reply: FastifyReply) => {
    if (!UUID.test(id)) {
      sendError(reply, 400, "invalid_id", "The book id is not valid.");
      return null;
    }
    const book = repo.get(id);
    if (!book) sendError(reply, 404, "not_found", "There is no book with this id.");
    return book ?? null;
  };

  api.get("/books", async (): Promise<BookListView> => ({ books: loadSummaries(repo, estimator) }));

  api.get<{ Params: { id: string } }>("/books/:id", async (req, reply) => {
    const book = withBook(req.params.id, reply);
    return book ? bookView(book.id) : reply;
  });

  api.patch<{ Params: { id: string }; Body: { language: Language } }>(
    "/books/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["language"],
          additionalProperties: false,
          properties: { language: { type: "string", enum: [...LANGUAGES] } },
        },
      },
    },
    async (req, reply) => {
      const book = withBook(req.params.id, reply);
      if (!book) return reply;
      if (!repo.setLanguage(book.id, req.body.language)) {
        return sendError(
          reply,
          409,
          "conflict",
          "The language can only be changed before converting.",
        );
      }
      // The text rules differ by language (Ukrainian spells out every number), so the length of the
      // text the engine is given does too: `setLanguage` forgot the counts, and they are made again
      // in the background (the estimates say "measuring" until they land).
      if (req.body.language !== book.language) counter.enqueue(book.id);
      return bookView(book.id);
    },
  );

  api.post<{ Params: { id: string } }>("/books/:id/convert", async (req, reply) => {
    const book = withBook(req.params.id, reply);
    if (!book) return reply;
    if (book.status !== "ready") {
      return sendError(
        reply,
        409,
        "conflict",
        "This book has already been converted or is converting.",
      );
    }
    // English is only a placeholder for a book whose language nobody could tell: the owner picks.
    if (book.languageSource === "unknown") {
      return sendError(
        reply,
        409,
        "language_not_chosen",
        "Choose the language of the book first: it could not be detected.",
      );
    }
    if (!catalog.voiceFor(book.language)) {
      const name = LANGUAGE_NAMES[book.language as Language] ?? book.language;
      return sendError(
        reply,
        422,
        "no_voice",
        `No ${name} voice is installed yet. Pick another language.`,
      );
    }
    // A concurrent request may have queued it first.
    if (!repo.queue(book.id)) {
      return sendError(
        reply,
        409,
        "conflict",
        "This book has already been converted or is converting.",
      );
    }
    // The workers write here; it is made now and never by them, so a deleted book stays deleted.
    storage.ensureAudioDir(book.id);
    const view = bookView(book.id);
    if (view) {
      bus.publish({
        type: "book",
        bookId: book.id,
        status: view.status,
        doneCount: view.doneCount,
        failedCount: view.failedCount,
        durationSeconds: view.durationSeconds,
      });
    }
    pool.notify();
    return reply.code(202).send(view);
  });

  api.get<{ Params: { id: string } }>("/books/:id/cover", async (req, reply) => {
    const book = withBook(req.params.id, reply);
    if (!book) return reply;
    if (!book.coverPath || !book.coverMime) {
      return sendError(reply, 404, "not_found", "This book has no cover.");
    }
    return sendFile(req, reply, storage.resolve(book.coverPath), book.coverMime);
  });

  api.get<{ Params: { id: string; position: string }; Querystring: { v?: string } }>(
    "/books/:id/chapters/:position/audio",
    async (req, reply) => {
      const book = withBook(req.params.id, reply);
      if (!book) return reply;
      if (!/^[1-9]\d{0,5}$/.test(req.params.position)) {
        return sendError(reply, 400, "invalid_position", "The chapter number is not valid.");
      }
      const chapter = repo.chapter(book.id, Number(req.params.position));
      if (!chapter) return sendError(reply, 404, "not_found", "There is no such chapter.");
      // A chapter that is being regenerated keeps its old audio until the new file replaces it.
      if (!chapter.audioPath) {
        return sendError(reply, 404, "not_ready", "This chapter has no audio yet.");
      }
      // The player asks for the version it started with. After the file was replaced, a later
      // Range request for the old one would return different bytes and break decoding.
      const { v } = req.query;
      if (v !== undefined) {
        if (typeof v !== "string" || !/^\d{1,9}$/.test(v)) {
          return sendError(reply, 400, "invalid_version", "The audio version is not valid.");
        }
        if (Number(v) !== chapter.audioVersion) {
          return sendError(
            reply,
            410,
            "version_changed",
            "A new version of this chapter is ready.",
          );
        }
      }
      return sendFile(req, reply, storage.resolve(chapter.audioPath), "audio/webm");
    },
  );
}
