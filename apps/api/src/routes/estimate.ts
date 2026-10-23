import type { FastifyInstance } from "fastify";
import { audioSecondsFor, type LanguageEstimateView } from "@book-to-audio/contracts";
import { LANGUAGES, type Language } from "../books/languages.js";
import { countPrepared } from "../books/prepared-chars.js";
import type { CountRepository } from "../books/count-repository.js";
import type { BookRepository } from "../books/repository.js";
import type { TextPreparer } from "../convert/chapter-text.js";
import type { Estimator } from "../speed/estimator.js";
import { TEXT_PROCESSING_VERSION } from "../text/index.js";
import type { TtsCatalog } from "../tts/catalog.js";
import { sameOriginOnly } from "../security.js";
import { sendError } from "./errors.js";

export interface EstimateRouteDeps {
  repo: BookRepository;
  counts: Pick<CountRepository, "chapterTexts">;
  catalog: TtsCatalog;
  estimator: Estimator;
  /** The text rules, held to the same few worker threads as the background counting. */
  prepareText: TextPreparer;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Books whose counts in another language are kept, so flipping the picker back and forth is instant. */
const CACHE_SIZE = 6;
/** Languages being worked out at once; more are refused, so a page that keeps asking cannot pile up work. */
const MAX_PENDING = 3;

/**
 * `GET /api/books/:id/estimate?language=uk`: the length and conversion time of a book that is
 * not converted yet, as if it were read in that language. The preview asks when the picker changes.
 */
export function registerEstimateRoute(api: FastifyInstance, deps: EstimateRouteDeps) {
  const { repo, catalog, estimator, prepareText } = deps;
  /** One count per book and language, shared by requests that arrive together. */
  const counts = new Map<string, Promise<number[]>>();
  const pending = new Set<string>();

  /** The counts, or null when too many other languages are being worked out already. */
  const countsFor = (bookId: string, language: string): Promise<number[]> | null => {
    // The split depends on the voice's service, so a change of voice counts again.
    const maxChars = catalog.maxCharsFor(language);
    const key = `${bookId}:${language}:${maxChars}:${TEXT_PROCESSING_VERSION}`;
    let found = counts.get(key);
    if (found) return found;
    if (pending.size >= MAX_PENDING) return null;
    pending.add(key);
    found = countPrepared(
      deps.counts.chapterTexts(bookId),
      language,
      maxChars,
      prepareText,
    ).finally(() => pending.delete(key));
    counts.set(key, found);
    found.catch(() => counts.delete(key));
    if (counts.size > CACHE_SIZE) counts.delete(counts.keys().next().value as string);
    return found;
  };

  api.get<{ Params: { id: string }; Querystring: { language: Language } }>(
    "/books/:id/estimate",
    {
      onRequest: sameOriginOnly,
      schema: {
        querystring: {
          type: "object",
          required: ["language"],
          additionalProperties: false,
          properties: { language: { type: "string", enum: [...LANGUAGES] } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      if (!UUID.test(id)) return sendError(reply, 400, "invalid_id", "The book id is not valid.");
      const book = repo.get(id);
      if (!book) return sendError(reply, 404, "not_found", "There is no book with this id.");
      if (book.status !== "ready") {
        return sendError(
          reply,
          409,
          "conflict",
          "Only a book that is not converted yet has a preview.",
        );
      }
      const { language } = req.query;
      let chars: number[];
      if (language === book.language) {
        const chapters = repo.chapters(id);
        if (chapters.some((chapter) => !chapter.counted)) {
          return { estimate: null, speed: null, chapterSeconds: [], measuring: true };
        }
        chars = chapters.map((chapter) => chapter.preparedChars);
      } else {
        const counting = countsFor(id, language);
        if (!counting) {
          return sendError(
            reply,
            429,
            "busy",
            "Still working out other languages. Try again in a moment.",
          );
        }
        chars = await counting;
      }
      const found = estimator.forBooks(repo.workload(), { bookId: id, language, chars }).get(id);
      const body: LanguageEstimateView = {
        estimate: found?.estimate ?? null,
        speed: found?.speed ?? null,
        chapterSeconds: found ? chars.map((count) => audioSecondsFor(found.speed, count)) : [],
        measuring: false,
      };
      return body;
    },
  );
}
