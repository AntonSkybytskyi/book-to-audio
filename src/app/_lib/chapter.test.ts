import { describe, expect, it } from "vitest";
import type { Chapter } from "./api";
import { canPlay, canRegenerate, isFinishing, isRegenerating, regenerateLabel } from "./chapter";

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
  hasAudio: false,
  audioVersion: 0,
  regenError: null,
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

describe("regenerating", () => {
  it("is regenerating while it waits or runs with the old audio still there", () => {
    expect(isRegenerating(chapter({ status: "queued", hasAudio: true }))).toBe(true);
    expect(isRegenerating(chapter({ status: "generating", hasAudio: true }))).toBe(true);
    expect(isRegenerating(chapter({ status: "generating", hasAudio: false }))).toBe(false);
    expect(isRegenerating(chapter({ status: "done", hasAudio: true }))).toBe(false);
  });

  it("offers Regenerate for finished, failed and running chapters only", () => {
    const offered = (["pending", "queued", "generating", "done", "failed"] as const).filter(
      (status) => canRegenerate(chapter({ status })),
    );

    expect(offered).toEqual(["generating", "done", "failed"]);
  });

  it("can be played whenever there is audio, whatever the chapter is doing", () => {
    expect(canPlay(chapter({ status: "queued", hasAudio: true }))).toBe(true);
    expect(canPlay(chapter({ status: "failed", hasAudio: true }))).toBe(true);
    expect(canPlay(chapter({ status: "done", hasAudio: false }))).toBe(false);
  });

  it("names the chapter in the button's label", () => {
    expect(regenerateLabel(chapter({ position: 3, title: "The Storm" }))).toBe(
      "Regenerate chapter 3: The Storm",
    );
  });
});
