import { UserFacingError } from "../errors.js";

/** A build that cannot finish, with a message the owner can act on. */
export class OutputError extends UserFacingError {
  constructor(message: string, options?: ErrorOptions & { detail?: string }) {
    super(message, options);
    this.name = "OutputError";
  }
}

/** ffmpeg or ffprobe ran and exited with an error. */
export class ToolExit extends OutputError {
  constructor(message: string, options?: ErrorOptions & { detail?: string }) {
    super(message, options);
    this.name = "ToolExit";
  }
}

/** Thrown inside a build that was cancelled; never shown. */
export class BuildCancelled extends Error {
  constructor() {
    super("The build was cancelled");
    this.name = "BuildCancelled";
  }
}

export const NO_SPACE_MESSAGE =
  "There is not enough free disk space to build the downloads. Free some space, then try again.";

export const GENERIC_BUILD_ERROR = "Something went wrong while building the downloads.";

/** What to tell the owner about a build that failed with `error`. */
export function buildErrorMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC") return NO_SPACE_MESSAGE;
  return GENERIC_BUILD_ERROR;
}
