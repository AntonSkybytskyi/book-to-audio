/**
 * An error whose `message` is safe and useful to show to the user. `detail`
 * holds anything technical (stderr, exit codes) and is only ever logged.
 */
export class UserFacingError extends Error {
  readonly detail: string | undefined;

  constructor(message: string, options?: ErrorOptions & { detail?: string }) {
    super(message, options);
    this.detail = options?.detail;
  }
}

/** Shown when a chapter fails for a reason we do not describe to the user. */
export const GENERIC_CHAPTER_ERROR = "Something went wrong while reading this chapter aloud.";
