import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";

/** `{ error, message }` with a machine readable `error` code. */
export const sendError = (reply: FastifyReply, status: number, error: string, message: string) =>
  reply.code(status).send({ error, message });

const MULTIPART_CODES: Record<string, [number, string, string]> = {
  FST_REQ_FILE_TOO_LARGE: [413, "too_large", "The file is larger than the upload limit."],
  FST_INVALID_MULTIPART_CONTENT_TYPE: [
    415,
    "unsupported_type",
    "Upload the file as multipart/form-data.",
  ],
  FST_PARTS_LIMIT: [400, "bad_request", "The upload has too many parts."],
  FST_FILES_LIMIT: [400, "bad_request", "Upload exactly one file."],
  FST_FIELDS_LIMIT: [400, "bad_request", "The upload has too many fields."],
};

/** One JSON error shape for everything under `/api`. */
export function registerErrorHandler(api: FastifyInstance) {
  api.setErrorHandler((error: FastifyError, req, reply) => {
    const known = error.code ? MULTIPART_CODES[error.code] : undefined;
    if (known) return sendError(reply, ...known);
    if (error.validation) return sendError(reply, 400, "bad_request", error.message);
    const status = error.statusCode ?? 500;
    if (status < 500) return sendError(reply, status, "bad_request", error.message);

    req.log.error({ err: error }, "request failed");
    return sendError(reply, 500, "internal", "Something went wrong on the server.");
  });
}
