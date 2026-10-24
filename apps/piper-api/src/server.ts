import {
  TTS_ERROR_STATUS,
  TTS_WAV_CONTENT_TYPE,
  type TtsServiceError,
  type TtsServiceErrorCode,
  type TtsServiceVoice,
  type TtsSynthesizeRequest,
  type TtsVoicesResponse,
} from "@book-to-audio/contracts";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";
import { TtsError } from "./errors.js";
import type { SynthesisPool } from "./synthesis-pool.js";
import { encodeWav } from "./wav.js";

export interface ServerDeps {
  logger?: FastifyServerOptions["logger"];
  voices(): TtsServiceVoice[];
  pool: Pick<SynthesisPool, "synthesize">;
  maxInputChars: number;
  concurrency: number;
  /** Why the service cannot read text aloud right now, or null when it can. */
  problem(): string | null;
}

/** Nginx's code for a client that closed the connection before the answer. */
const CLIENT_CLOSED = 499;

const sendError = (
  reply: FastifyReply,
  code: TtsServiceErrorCode,
  message: string,
  detail?: string,
) => {
  const body: TtsServiceError = { code, message, ...(detail === undefined ? {} : { detail }) };
  return reply.code(TTS_ERROR_STATUS[code]).send(body);
};

/** The TTS service API (packages/contracts/openapi/tts-service.yaml) in front of Piper. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  // Docker and the app ask these every few seconds; only failures are worth a log line.
  app.get("/health", { logLevel: "warn" }, async (_req, reply) => {
    const problem = deps.problem();
    if (problem) return reply.code(503).send({ status: "error", reason: problem });
    return { status: "ok" };
  });

  app.get("/voices", { logLevel: "warn" }, async (): Promise<TtsVoicesResponse> => ({
    voices: deps.voices(),
    maxInputChars: deps.maxInputChars,
    concurrency: deps.concurrency,
  }));

  app.post<{ Body: TtsSynthesizeRequest }>(
    "/synthesize",
    {
      schema: {
        body: {
          type: "object",
          required: ["voice", "text"],
          additionalProperties: false,
          properties: {
            voice: { type: "string", minLength: 1 },
            text: { type: "string", minLength: 1, maxLength: deps.maxInputChars },
          },
        },
      },
    },
    async (req, reply) => {
      // A client that hangs up no longer wants the audio: stop waiting, or stop Piper.
      const controller = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) controller.abort();
      });
      try {
        const audio = await deps.pool.synthesize(req.body.voice, req.body.text, controller.signal);
        return reply.header("content-type", TTS_WAV_CONTENT_TYPE).send(encodeWav(audio));
      } catch (error) {
        // Cancelled while the client is still there: the service is stopping. A 503 without the API's
        // error body tells the client the service went away, so it tries again later.
        if (error instanceof TtsError && error.code === "aborted" && !controller.signal.aborted) {
          return reply.code(503).send({ status: "stopping" });
        }
        throw error;
      }
    },
  );

  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (error instanceof TtsError) {
      if (error.code === "aborted") {
        req.log.info("client went away, synthesis stopped");
        return reply.code(CLIENT_CLOSED).send();
      }
      if (error.code !== "bad_input" && error.code !== "voice_not_found") {
        req.log.warn({ code: error.code, detail: error.detail }, error.message);
      }
      return sendError(reply, error.code, error.message, error.detail);
    }
    if ((error.statusCode ?? 500) < 500) {
      return sendError(reply, "bad_input", "This text cannot be read aloud.", error.message);
    }
    req.log.error({ err: error }, "request failed");
    return sendError(reply, "synthesis_failed", "The speech service failed on this text.");
  });

  return app;
}
