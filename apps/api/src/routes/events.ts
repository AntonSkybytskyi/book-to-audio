import type { FastifyInstance } from "fastify";
import type { PoolControl } from "../convert/pool.js";
import type { AppEvent, EventBus } from "../events/bus.js";
import { API_SECURITY_HEADERS } from "../security.js";
import { sendError } from "./errors.js";

export interface EventStreamLimits {
  /** Time between keep-alive comments. */
  heartbeatMs?: number;
  /** Most streams open at once. */
  maxStreams?: number;
  /** A client with more than this waiting to be sent is cut off. */
  maxBufferedBytes?: number;
}

export interface EventsRouteDeps extends EventStreamLimits {
  bus: EventBus;
  pool: Pick<PoolControl, "status">;
}

const HEARTBEAT_MS = 20_000;
const MAX_STREAMS = 32;
/** A client that has not read this much is gone or stuck; drop it rather than buffer. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
/** How long the browser waits before it reconnects. */
const RECONNECT_MS = 3000;

interface Stream {
  /** Ends the response cleanly, for shutdown. */
  end(): void;
}

/**
 * `GET /api/events`: server-sent events for chapter progress, book status, pool
 * state and new books. Every message has an `id` (the event's sequence number),
 * `event: <type>` and one line of JSON.
 */
export function registerEventsRoute(
  api: FastifyInstance,
  {
    bus,
    pool,
    heartbeatMs = HEARTBEAT_MS,
    maxStreams = MAX_STREAMS,
    maxBufferedBytes = MAX_BUFFERED_BYTES,
  }: EventsRouteDeps,
) {
  const open = new Set<Stream>();

  api.get("/events", (req, reply) => {
    // EventSource only sends same-origin GETs; anything else is another site's page.
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      return sendError(reply, 403, "forbidden", "Requests from other sites are not allowed.");
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !isSameHost(origin, req.headers.host)) {
      return sendError(reply, 403, "forbidden", "Requests from other sites are not allowed.");
    }
    if (open.size >= maxStreams) {
      return sendError(reply, 429, "busy", "Too many pages are listening for updates.");
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...API_SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // The socket is not reused after the stream ends, so closing the server is not held up by it.
      Connection: "close",
      "X-Accel-Buffering": "no",
    });
    req.raw.socket.setNoDelay(true);

    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    const stream: Stream = {
      end: () => {
        stop();
        if (!res.writableEnded && !res.destroyed) res.end();
      },
    };
    /** Stops everything that writes to this response. Safe to call many times. */
    const stop = () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      unsubscribe = undefined;
      open.delete(stream);
    };
    const write = (chunk: string) => {
      if (closed || res.writableEnded || res.destroyed) return;
      if (res.writableLength > maxBufferedBytes) {
        // Not reading: cut the connection instead of holding its backlog in memory.
        stop();
        res.destroy();
        return;
      }
      res.write(chunk);
    };

    // An error on the socket (reset, broken pipe) must not reach the process as uncaught.
    res.on("error", stop);
    res.once("close", stop);
    // The client may have left while hooks ran before this handler; `close` has fired by
    // now and will not fire again, so nothing would ever release the slot.
    if (req.raw.destroyed || res.destroyed) {
      stop();
      res.destroy();
      return;
    }
    open.add(stream);

    try {
      write(`retry: ${RECONNECT_MS}\n\n`);
      // The current pool state first, so a new page knows about a pause without asking, and
      // knows which events came before it.
      write(format({ type: "pool", ...pool.status() }, bus.currentSeq));
      unsubscribe = bus.subscribe((event, seq) => write(format(event, seq)));
      heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
      heartbeat.unref();
      // A write above may have failed and stopped the stream before these existed.
      if (closed) stop();
    } catch (error) {
      // Whatever was set up so far is released, and the client reconnects on its own.
      req.log.error({ err: error }, "could not start the event stream");
      stop();
      res.destroy();
    }
  });

  // Streams never end on their own, so `app.close()` would wait for them forever.
  // `preClose` runs before the server stops accepting; `onClose` would be too late.
  api.addHook("preClose", async () => {
    for (const stream of open) stream.end();
  });
}

const format = (event: AppEvent, seq: number) =>
  `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

function isSameHost(origin: string, host: string | undefined): boolean {
  try {
    return host !== undefined && new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
