import fs from "node:fs";
import path from "node:path";
import { BookControls, type BookControlsDeps } from "../books/controls.js";
import { BookTransitions } from "../books/transitions.js";
import type { ChapterRun } from "../convert/convert-chapter.js";
import { TtsError } from "../tts/engine.js";
import { ok, stubConverter, until, type PoolHarness } from "./pool-harness.js";

/** The gate name of a chapter, as `Gates` spells it. */
export const key = (id: string, position: number) => `${id.slice(0, 4)}:${position}`;

/** Book controls on the harness's running pool. */
export function controlsFor(h: PoolHarness, extra: Partial<BookControlsDeps> = {}): BookControls {
  if (!h.pool) throw new Error("start the pool first");
  return new BookControls({
    repo: h.repo,
    queue: h.queue,
    transitions: new BookTransitions(h.ctx.db, h.queue),
    storage: h.ctx.storage,
    bus: h.ctx.bus,
    pool: h.pool,
    outputs: h.ctx.outputs,
    ...extra,
  });
}

/** Chapters wait at a gate; an abort ends the attempt as cancelled, like the real converter. */
export const gatedConverter = (h: PoolHarness, onRun?: (run: ChapterRun) => void) =>
  stubConverter(async (run) => {
    onRun?.(run);
    await h.gates.hold(run);
    if (run.signal.aborted) throw new TtsError("aborted", "Conversion was cancelled");
    return ok(run);
  });

export const finishAll = async (h: PoolHarness, id: string) => {
  await until(() => h.bookStatus(id) === "done");
};

/** A saved chunk, so tests can see whether it is discarded. */
export function writeParts(h: PoolHarness, id: string, position: number): string {
  const dir = h.ctx.storage.partsDir(id, position);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "00000.webm"), "x");
  return dir;
}
