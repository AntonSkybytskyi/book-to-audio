import http from "node:http";
import https from "node:https";
import {
  MAX_WORKERS,
  TTS_ERROR_CODES,
  TTS_WAV_CONTENT_TYPE,
  type TtsServiceErrorCode,
  type TtsServiceVoice,
  type TtsVoicesResponse,
} from "@book-to-audio/contracts";
import { sleep } from "../convert/retry.js";
import { TtsError, type PcmAudio, type TtsEngine, type TtsSession, type Voice } from "./engine.js";
import { decodeWav } from "./wav.js";

export interface HttpTtsEngineOptions {
  /** The service's name in `TTS_SERVICES`; it goes in front of every voice id. */
  id: string;
  /** For example `http://piper-api:5000`; a path in it is kept, so `/tts` asks `/tts/voices`. */
  baseUrl: string;
  /** Longest wait for one `POST /synthesize`, time in the service's queue included. */
  requestTimeoutMs?: number;
  /** Longest wait for `GET /voices`. */
  voicesTimeoutMs?: number;
  /** Waits before each retry of a request that could not reach the service. */
  retryDelaysMs?: readonly number[];
}

/** The service did not answer at all: nothing was sent, or the connection broke before a response. */
const CONNECTION_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
]);
const KNOWN_CODES = new Set<string>(TTS_ERROR_CODES);
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 300;

interface Response {
  status: number;
  contentType: string;
  body: Buffer;
}

/** A failed request that never got a response. */
class ConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A TTS service reached over the TTS service API (packages/contracts/openapi/tts-service.yaml).
 * `refresh()` asks it for its voices and limits; until it answers once it has no voices. Voice
 * ids get the service's name in front (`piper:en_US-lessac-medium`), so two services never clash.
 */
export class HttpTtsEngine implements TtsEngine {
  readonly id: string;
  maxInputChars = 1000;
  concurrency = 1;
  ready = false;
  reachable = false;
  /** Why the service did not answer the last time, until it answers again. */
  lastError: TtsError | undefined;
  private voiceList: Voice[] = [];
  private readonly baseUrl: URL;
  private readonly agent: http.Agent;
  private readonly options: Required<Omit<HttpTtsEngineOptions, "id" | "baseUrl">>;

  constructor(options: HttpTtsEngineOptions) {
    this.id = options.id;
    this.baseUrl = new URL(options.baseUrl);
    this.agent =
      this.baseUrl.protocol === "https:"
        ? new https.Agent({ keepAlive: true })
        : new http.Agent({ keepAlive: true });
    this.options = {
      requestTimeoutMs: 10 * 60_000,
      voicesTimeoutMs: 5000,
      retryDelaysMs: [250, 1000],
      ...options,
    };
  }

  voices(): Voice[] {
    return [...this.voiceList];
  }

  /**
   * Asks the service for its voices and limits. When it does not answer, the voices it listed
   * before are kept, so chapters waiting for them resume when it is back. True when anything changed.
   */
  async refresh(): Promise<boolean> {
    const before = this.snapshot();
    let answer: TtsVoicesResponse;
    try {
      const response = await this.request("GET", "/voices", undefined, {
        timeoutMs: this.options.voicesTimeoutMs,
        retryDelaysMs: [],
      });
      if (response.status !== 200) throw this.errorFrom(response);
      answer = parseVoices(response.body);
    } catch (error) {
      if (!(error instanceof TtsError)) {
        this.reachable = false;
        throw error;
      }
      this.markDown(error);
      return before !== this.snapshot();
    }
    // Read now, not before the request: a chapter may have found the service gone meanwhile, and
    // its workers only come back when this answer counts as a change.
    const wasReachable = this.reachable;
    this.voiceList = this.qualify(answer.voices);
    this.maxInputChars = answer.maxInputChars;
    // The app never runs more workers for one service than the settings accept.
    this.concurrency = Math.min(answer.concurrency, MAX_WORKERS);
    this.ready = true;
    this.reachable = true;
    this.lastError = undefined;
    return !wasReachable || before !== this.snapshot();
  }

  async open(voiceId: string): Promise<TtsSession> {
    if (!this.ready) {
      throw new TtsError("unreachable", this.unreachableMessage(), {
        detail: "no answer to GET /voices yet",
      });
    }
    const voice = this.voiceList.find((v) => v.id === voiceId);
    if (!voice)
      throw new TtsError(
        "voice_not_found",
        `The speech service "${this.id}" has no voice "${voiceId}".`,
      );
    const bare = voiceId.slice(this.id.length + 1);
    // Nothing to load here: the service keeps the model warm. Closing cancels a chunk in flight.
    const closing = new AbortController();
    return {
      synthesize: (text, signal) =>
        this.synthesize(
          bare,
          text,
          signal ? AbortSignal.any([signal, closing.signal]) : closing.signal,
        ),
      close: async () => closing.abort(),
    };
  }

  private async synthesize(voice: string, text: string, signal: AbortSignal): Promise<PcmAudio> {
    if (signal.aborted) throw new TtsError("aborted", "Synthesis was cancelled");
    const response = await this.request("POST", "/synthesize", JSON.stringify({ voice, text }), {
      timeoutMs: this.options.requestTimeoutMs,
      retryDelaysMs: this.options.retryDelaysMs,
      signal,
    });
    if (response.status !== 200) throw this.errorFrom(response);
    if (!response.contentType.startsWith(TTS_WAV_CONTENT_TYPE)) {
      throw new TtsError("synthesis_failed", "The speech service sent audio the app cannot read.", {
        detail: `content type "${response.contentType}"`,
      });
    }
    return decodeWav(response.body);
  }

  /** One request, tried again only when it could not reach the service. */
  private async request(
    method: "GET" | "POST",
    path: string,
    body: string | undefined,
    {
      timeoutMs,
      retryDelaysMs,
      signal,
    }: { timeoutMs: number; retryDelaysMs: readonly number[]; signal?: AbortSignal },
  ): Promise<Response> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const url = this.urlOf(path);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send(method, url, body, combined);
      } catch (error) {
        if (signal?.aborted)
          throw new TtsError("aborted", "Synthesis was cancelled", { cause: error });
        if (deadline.aborted) {
          throw new TtsError("timeout", `The speech service "${this.id}" took too long.`, {
            cause: error,
            detail: `${method} ${url.href} took longer than ${timeoutMs / 1000} s`,
          });
        }
        if (!(error instanceof ConnectionError)) throw error;
        const delay = retryDelaysMs[attempt];
        if (delay === undefined) {
          throw this.markDown(
            new TtsError("unreachable", this.unreachableMessage(), {
              cause: error,
              detail: `${method} ${url.href}: ${error.code} after ${attempt + 1} attempts`,
            }),
          );
        }
        await sleep(delay, combined);
      }
    }
  }

  private send(
    method: string,
    url: URL,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const transport = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(url, {
        method,
        agent: this.agent,
        signal,
        headers:
          body === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      });
      let responded = false;
      request.on("response", (response) => {
        responded = true;
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            request.destroy();
            reject(
              new TtsError("synthesis_failed", "The speech service sent too much audio.", {
                detail: `${method} ${url.href}: more than ${MAX_BODY_BYTES} bytes`,
              }),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: response.headers["content-type"] ?? "",
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", (error: NodeJS.ErrnoException) =>
          reject(
            signal.aborted
              ? error
              : new TtsError(
                  "synthesis_failed",
                  `The speech service "${this.id}" stopped answering.`,
                  {
                    cause: error,
                    detail: `${method} ${url.href}: ${error.code ?? error.message}`,
                  },
                ),
          ),
        );
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
        if (!responded && error.code && CONNECTION_ERRORS.has(error.code)) {
          reject(new ConnectionError(error.code, error.message));
        } else {
          reject(
            signal.aborted
              ? error
              : new TtsError(
                  "synthesis_failed",
                  `The speech service "${this.id}" stopped answering.`,
                  {
                    cause: error,
                    detail: `${method} ${url.href}: ${error.code ?? error.message}`,
                  },
                ),
          );
        }
      });
      request.end(body);
    });
  }

  private errorFrom(response: Response): TtsError {
    const detail = `HTTP ${response.status}`;
    try {
      const error = JSON.parse(response.body.toString("utf8")) as {
        code?: unknown;
        message?: unknown;
        detail?: unknown;
      };
      if (
        typeof error.code === "string" &&
        KNOWN_CODES.has(error.code) &&
        typeof error.message === "string"
      ) {
        return new TtsError(
          error.code as TtsServiceErrorCode,
          error.message.slice(0, MAX_MESSAGE_CHARS),
          {
            detail: typeof error.detail === "string" ? `${detail}: ${error.detail}` : detail,
          },
        );
      }
    } catch {
      // Not the API's error body; the status says what it can.
    }
    if ([502, 503, 504].includes(response.status)) {
      // A proxy in front of the service, or a service that is stopping: it is not there to read.
      return this.markDown(new TtsError("unreachable", this.unreachableMessage(), { detail }));
    }
    return new TtsError(
      "synthesis_failed",
      `The speech service "${this.id}" failed on this text.`,
      { detail },
    );
  }

  /** The base URL's path and query kept, which `new URL(path, base)` would drop. */
  private urlOf(path: string): URL {
    const url = new URL(this.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
    return url;
  }

  private markDown(error: TtsError): TtsError {
    this.reachable = false;
    this.lastError = error;
    return error;
  }

  private snapshot(): string {
    return JSON.stringify([this.voiceList, this.maxInputChars, this.concurrency, this.reachable]);
  }

  private unreachableMessage(): string {
    return `The speech service "${this.id}" is not reachable.`;
  }

  private qualify(voices: TtsServiceVoice[]): Voice[] {
    const seen = new Set<string>();
    const result: Voice[] = [];
    for (const { id, language, name, sampleRate, speaker } of voices) {
      const qualified = `${this.id}:${id}`;
      if (seen.has(qualified)) continue;
      seen.add(qualified);
      result.push({
        id: qualified,
        language,
        name,
        sampleRate,
        ...(speaker === undefined ? {} : { speaker }),
      });
    }
    return result;
  }
}

const invalid = (why: string) =>
  new TtsError(
    "synthesis_failed",
    "The speech service listed its voices in a form the app cannot read.",
    {
      detail: `GET /voices: ${why}`,
    },
  );

function parseVoices(body: Buffer): TtsVoicesResponse {
  let answer: unknown;
  try {
    answer = JSON.parse(body.toString("utf8"));
  } catch {
    throw invalid("not JSON");
  }
  const { voices, maxInputChars, concurrency } = (answer ?? {}) as Record<string, unknown>;
  if (!Array.isArray(voices)) throw invalid("no voices list");
  if (!isPositiveInteger(maxInputChars)) throw invalid("maxInputChars is not a positive integer");
  if (!isPositiveInteger(concurrency)) throw invalid("concurrency is not a positive integer");
  const valid = voices.filter(
    (v): v is TtsServiceVoice =>
      typeof v === "object" &&
      v !== null &&
      typeof v.id === "string" &&
      v.id !== "" &&
      typeof v.language === "string" &&
      typeof v.name === "string" &&
      isPositiveInteger(v.sampleRate) &&
      (v.speaker === undefined || typeof v.speaker === "string"),
  );
  return { voices: valid, maxInputChars, concurrency };
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
