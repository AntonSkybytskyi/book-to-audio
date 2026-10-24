import { describe, expect, it } from "vitest";
import { FakeEngine } from "../testing/fake-engine.js";
import { ok, stubConverter, tick, until, usePoolHarness } from "../testing/pool-harness.js";
import { TtsCatalog } from "../tts/catalog.js";
import { TtsError } from "../tts/engine.js";
import type { ChapterRun } from "./convert-chapter.js";

const voice = (id: string, language: string) => ({ id, language, name: id, sampleRate: 22_050 });

describe("WorkerPool: several TTS services", () => {
  const h = usePoolHarness();
  let piper: FakeEngine;
  let other: FakeEngine;
  let chosen: Record<string, string>;

  const services = (piperConcurrency = 2, otherConcurrency = 3) => {
    piper = new FakeEngine({
      id: "piper",
      concurrency: piperConcurrency,
      voices: [voice("piper:en", "en"), voice("piper:uk", "uk")],
    });
    other = new FakeEngine({
      id: "other",
      concurrency: otherConcurrency,
      voices: [voice("other:uk", "uk"), voice("other:ru", "ru")],
    });
    chosen = {};
    return new TtsCatalog([piper, other], { chosenVoice: (language) => chosen[language] });
  };

  /** Each chapter waits at a gate, and records the service of the worker that took it. */
  const taken: { service: string; language: string }[] = [];
  const recording = () =>
    stubConverter(async (run: ChapterRun) => {
      taken.push({ service: run.sessions.engineId, language: run.task.language });
      await h.gates.hold(run);
      return ok(run);
    });

  const start = (catalog: TtsCatalog, converter = recording()) => {
    taken.length = 0;
    return h.start(converter, 1, { catalog });
  };

  it("runs as many workers for each service as it reports, or the number set for it", async () => {
    const pool = start(services(2, 3));

    expect(pool.status()).toMatchObject({
      workers: 5,
      services: [
        { id: "piper", workers: 2, reportedWorkers: 2, reachable: true },
        { id: "other", workers: 3, reportedWorkers: 3, reachable: true },
      ],
    });

    h.ctx.settings.setWorkersOverride("other", 1);
    expect(pool.refreshWorkers().services.map((s) => s.workers)).toEqual([2, 1]);
  });

  it("gives each worker only chapters whose language is read by its service", async () => {
    const pool = start(services(1, 1));
    const en = h.addBook(1, true, "en");
    const ru = h.addBook(1, true, "ru");
    pool.notify();

    await until(() => h.gates.open.length === 2);

    expect(taken.toSorted((a, b) => a.service.localeCompare(b.service))).toEqual([
      { service: "other", language: "ru" },
      { service: "piper", language: "en" },
    ]);
    h.gates.releaseAll();
    await until(() => h.bookStatus(en) === "done" && h.bookStatus(ru) === "done");
  });

  it("reads a language on the service of the voice chosen for it, from the next chapter on", async () => {
    const pool = start(services(1, 1));
    const book = h.addBook(2, true, "uk");
    pool.notify();
    await until(() => h.gates.open.length === 1);
    expect(taken[0]?.service).toBe("piper"); // the first service with a Ukrainian voice

    chosen.uk = "other:uk";
    pool.refreshWorkers();
    h.gates.releaseAll();

    await until(() => taken.length === 2);
    expect(taken[1]?.service).toBe("other");
    h.gates.releaseAll();
    await until(() => h.bookStatus(book) === "done");
  });

  it("pauses only the service whose chapters keep failing", async () => {
    const pool = start(
      services(1, 1),
      stubConverter(async (run) => {
        if (run.sessions.engineId === "piper")
          throw new TtsError("synthesis_failed", "Piper broke.");
        return ok(run);
      }),
    );
    const en = h.addBook(4, true, "en");
    const ru = h.addBook(3, true, "ru");
    pool.notify();

    await until(() => h.bookStatus(ru) === "done");
    await until(() => pool.status().services[0]?.state === "paused");

    expect(pool.status()).toMatchObject({
      state: "running",
      services: [
        { id: "piper", state: "paused", error: "Piper broke." },
        { id: "other", state: "running", error: null },
      ],
    });
    expect(h.status(en, 4)).toBe("queued");

    pool.resume("piper");
    await until(() => h.status(en, 4) === "failed");
  });

  it("puts the chapter back when its service does not answer, and gives the service no workers", async () => {
    let down = true;
    const pool = start(
      services(1, 1),
      stubConverter(async (run) => {
        if (down && run.sessions.engineId === "piper") {
          piper.reachable = false;
          throw new TtsError("unreachable", 'The speech service "piper" is not reachable.');
        }
        return ok(run);
      }),
    );
    const en = h.addBook(1, true, "en");
    pool.notify();

    await until(() => pool.status().services[0]?.workers === 0);
    await tick();

    expect(h.status(en, 1)).toBe("queued");
    expect(pool.status().services[0]).toMatchObject({ state: "running", reachable: false });

    down = false;
    piper.reachable = true;
    pool.refreshWorkers();
    await until(() => h.bookStatus(en) === "done");
  });

  it("fails a chapter whose service stops answering every time it reads it", async () => {
    const pool = start(
      services(1, 1),
      stubConverter(async (run) => {
        if (run.task.position === 1) {
          throw new TtsError("unreachable", 'The speech service "piper" is not reachable.');
        }
        return ok(run);
      }),
    );
    const en = h.addBook(2, true, "en");
    pool.notify();

    await until(() => h.status(en, 1) === "failed" && h.status(en, 2) === "done");

    expect(h.repo.chapter(en, 1)?.error).toBe(
      'The speech service "piper" stopped answering each time it read this chapter.',
    );
  });

  it("leaves chapters with no voice anywhere queued, and still counts as idle", async () => {
    const pool = start(services(1, 1));
    const de = h.addBook(1, true, "de");
    pool.notify();
    await tick();

    expect(h.status(de, 1)).toBe("queued");
    const release = await pool.holdWhenIdle();
    release();
  });
});
