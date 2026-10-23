import { LogController } from "fastify";

/**
 * Logs one short line per request that matters: anything that is not a GET, and
 * any failure. The UI polls every 2 seconds, so logging every request with its
 * full request and response objects would drown everything else.
 */
export class QuietLogController extends LogController {
  override incomingRequest(): void {}

  override requestCompleted(
    error: Error | null | undefined,
    request: Parameters<LogController["requestCompleted"]>[1],
    reply: Parameters<LogController["requestCompleted"]>[2],
  ): void {
    const status = reply.statusCode;
    if (request.method === "GET" && status < 400 && !error) return;

    const fields = {
      method: request.method,
      url: request.url.split("?")[0],
      status,
      ms: Math.round(reply.elapsedTime),
    };
    if (status >= 500 || error) request.log.error({ ...fields, err: error }, "request failed");
    else if (status >= 400) request.log.warn(fields, "request rejected");
    else request.log.info(fields, "request");
  }
}
