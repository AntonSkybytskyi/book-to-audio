import type { Chapter } from "./api";

/** All chunks are read and the chapter is still being joined into its file. */
export const isFinishing = (chapter: Chapter): boolean =>
  chapter.status === "generating" &&
  chapter.chunkCount > 0 &&
  chapter.chunksDone >= chapter.chunkCount;

/** Being synthesized again while the old audio can still be played. */
export const isRegenerating = (chapter: Chapter): boolean =>
  chapter.hasAudio && (chapter.status === "queued" || chapter.status === "generating");

/** Chapters that have a Regenerate button: finished, failed, or running (which loses its work). */
export const canRegenerate = (chapter: Chapter): boolean =>
  chapter.status === "done" || chapter.status === "failed" || chapter.status === "generating";

/** The chapter can be played: it has audio, whatever it is doing now. */
export const canPlay = (chapter: Chapter): boolean => chapter.hasAudio;

/** Accessible name of the per-chapter button, e.g. "Regenerate chapter 3: The Storm". */
export const regenerateLabel = (chapter: Chapter): string =>
  `Regenerate chapter ${chapter.position}: ${chapter.title}`;
