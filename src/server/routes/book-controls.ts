import type { FastifyInstance, FastifyReply } from "fastify";
import { ControlError, type BookControls } from "../books/controls.js";
import type { BookRepository } from "../books/repository.js";
import { loadBookView } from "../books/views.js";
import type { Estimator } from "../speed/estimator.js";
import type { TtsEngine } from "../tts/engine.js";
import { sendError } from "./errors.js";

export interface BookControlRouteDeps {
  repo: BookRepository;
  engine: TtsEngine;
  controls: BookControls;
  estimator: Estimator;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITION = /^[1-9]\d{0,5}$/;

/** Runs `action`, and turns a refused request into its 400, 404 or 409 answer. */
const run = async (
  reply: FastifyReply,
  id: string,
  action: () => Promise<unknown>,
  answer: () => unknown,
) => {
  if (!UUID.test(id)) return sendError(reply, 400, "invalid_id", "The book id is not valid.");
  try {
    await action();
  } catch (error) {
    if (error instanceof ControlError)
      return sendError(reply, error.status, error.code, error.message);
    throw error;
  }
  return answer();
};

/**
 * `POST /books/:id/pause`, `/resume`, `/regenerate`, `POST /books/:id/chapters/:position/regenerate`
 * and `DELETE /books/:id`. The first four answer with the book as it is afterwards.
 */
export function registerBookControlRoutes(api: FastifyInstance, deps: BookControlRouteDeps) {
  const { repo, engine, controls, estimator } = deps;

  const view = (id: string) => () => loadBookView(repo, engine, estimator, id);

  api.post<{ Params: { id: string } }>("/books/:id/pause", (req, reply) =>
    run(reply, req.params.id, () => controls.pause(req.params.id), view(req.params.id)),
  );

  api.post<{ Params: { id: string } }>("/books/:id/resume", (req, reply) =>
    run(reply, req.params.id, () => controls.resume(req.params.id), view(req.params.id)),
  );

  api.post<{ Params: { id: string } }>("/books/:id/regenerate", (req, reply) =>
    run(reply, req.params.id, () => controls.regenerateBook(req.params.id), view(req.params.id)),
  );

  api.post<{ Params: { id: string; position: string } }>(
    "/books/:id/chapters/:position/regenerate",
    (req, reply) => {
      const { id, position } = req.params;
      if (!POSITION.test(position)) {
        return sendError(reply, 400, "invalid_position", "The chapter number is not valid.");
      }
      return run(reply, id, () => controls.regenerateChapter(id, Number(position)), view(id));
    },
  );

  api.delete<{ Params: { id: string } }>("/books/:id", (req, reply) =>
    run(
      reply,
      req.params.id,
      async () => {
        const { filesError } = await controls.delete(req.params.id);
        // The book is gone; what could not be removed is swept at the next start.
        if (filesError) {
          req.log.warn({ err: filesError, bookId: req.params.id }, "could not remove all files");
        }
      },
      () => reply.code(204).send(),
    ),
  );
}
