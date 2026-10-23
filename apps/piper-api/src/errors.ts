import type { TtsServiceErrorCode } from "@book-to-audio/contracts";

/**
 * Why a text could not be read aloud. `message` is one sentence the app can show to the user;
 * `detail` holds anything technical (stderr, exit codes) for the logs. `aborted` never goes over
 * the wire: the client that asked has gone.
 */
export class TtsError extends Error {
  readonly code: TtsServiceErrorCode | "aborted";
  readonly detail: string | undefined;

  constructor(
    code: TtsServiceErrorCode | "aborted",
    message: string,
    options?: ErrorOptions & { detail?: string },
  ) {
    super(message, options);
    this.name = "TtsError";
    this.code = code;
    this.detail = options?.detail;
  }
}
