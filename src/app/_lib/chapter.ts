import type { Chapter } from "./api";

/** All chunks are read and the chapter is still being joined into its file. */
export const isFinishing = (chapter: Chapter): boolean =>
  chapter.status === "generating" &&
  chapter.chunkCount > 0 &&
  chapter.chunksDone >= chapter.chunkCount;
