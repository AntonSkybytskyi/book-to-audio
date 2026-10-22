export type EpubErrorCode =
  | "not_epub" // not a zip, or a zip that is not an EPUB
  | "drm" // content is encrypted or carries a rights file
  | "no_chapters" // valid EPUB, but no readable text
  | "unsafe_archive" // too many entries, or too much data or markup once unpacked
  | "too_many_chapters";

/** A problem with the uploaded file itself. The message is safe to show to the user. */
export class EpubError extends Error {
  readonly code: EpubErrorCode;

  constructor(code: EpubErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EpubError";
    this.code = code;
  }
}
