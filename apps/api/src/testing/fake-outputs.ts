import fs from "node:fs";
import path from "node:path";
import type { OutputJob, OutputProducer } from "../outputs/produce.js";

/** Stands in for ffmpeg: the "M4B" and "ZIP" are small text files that say what they were built from. */
export const fakeProducer: OutputProducer = {
  async produce(job: OutputJob) {
    const m4bPath = path.join(job.workDir, "book.m4b");
    const zipPath = path.join(job.workDir, "book.zip");
    fs.writeFileSync(m4bPath, `m4b of ${job.book.title}: ${job.chapters.length} chapters`);
    fs.writeFileSync(zipPath, `zip of ${job.book.title}: ${job.chapters.length} chapters`);
    job.onProgress(1);
    return { m4bPath, zipPath };
  },
};
