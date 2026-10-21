import { describe, expect, it } from "vitest";
import type { Chapter } from "./api";
import { isFinishing } from "./chapter";

const chapter = (overrides: Partial<Chapter>): Chapter => ({
  position: 1,
  title: "One",
  status: "generating",
  progress: 0,
  error: null,
  charCount: 10,
  wordCount: 2,
  estimatedMinutes: 1,
  durationSeconds: null,
  chunkCount: 8,
  chunksDone: 3,
  ...overrides,
});

describe("isFinishing", () => {
  it("is false while chunks are still being read", () => {
    expect(isFinishing(chapter({ chunksDone: 7 }))).toBe(false);
  });

  it("is true once every chunk is read and the chapter is not done yet", () => {
    expect(isFinishing(chapter({ chunksDone: 8, progress: 1 }))).toBe(true);
  });

  it("is false for a chapter that has not started, is done, or was re-queued", () => {
    expect(isFinishing(chapter({ chunkCount: 0, chunksDone: 0 }))).toBe(false);
    expect(isFinishing(chapter({ status: "done", chunksDone: 8 }))).toBe(false);
    expect(isFinishing(chapter({ status: "queued", chunksDone: 8 }))).toBe(false);
  });
});
