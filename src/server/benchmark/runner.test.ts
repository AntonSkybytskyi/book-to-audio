import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { TEXT_PROCESSING_VERSION } from "../text/index.js";
import { TimedEngine } from "../testing/timed-engine.js";
import { TtsError, type TtsEngine } from "../tts/engine.js";
import { here, useRunnerHarness, waitFor } from "../testing/runner-harness.js";
import { BenchmarkBusyError, workerCountsFor } from "./runner.js";

describe("workerCountsFor", () => {
  it("compares one up to four sessions", () => {
    expect(workerCountsFor(2, 12)).toEqual([1, 2, 3, 4]);
    expect(workerCountsFor(1, 12)).toEqual([1, 2, 3, 4]);
  });

  it("stays within the most the settings allow", () => {
    expect(workerCountsFor(1, 2)).toEqual([1, 2]);
    expect(workerCountsFor(1, 1)).toEqual([1]);
  });

  it("adds the worker count in use when it is higher, up to a limit, so it is measured and not guessed", () => {
    expect(workerCountsFor(6, 12)).toEqual([1, 2, 3, 4, 6]);
    expect(workerCountsFor(12, 12)).toEqual([1, 2, 3, 4, 8]);
    expect(workerCountsFor(6, 5)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("BenchmarkRunner", () => {
  const h = useRunnerHarness();

  describe("a run", () => {
    it("measures the default voice of each language and saves the results together", async () => {
      h.runner.start("manual");
      await h.finished();

      const saved = h.repo.all("timed");
      expect(saved.map((row) => row.voiceId).toSorted()).toEqual(["t-en", "t-ru", "t-uk"]);
      expect(saved[0]).toMatchObject({
        cpuCount: 8,
        cpuModel: "Test CPU",
        textVersion: TEXT_PROCESSING_VERSION,
        measuredAt: "2026-03-04T05:06:07.000Z",
      });
      // Up to the worker count in use, which is 2 of at most 3.
      expect(saved[0]?.throughput.map((p) => p.workers)).toEqual([1, 2, 3]);
      expect(h.runner.status()).toMatchObject({ state: "idle", outcome: "completed", error: null });
    });

    it("holds the pool for the whole run and gives it back", async () => {
      h.runner.start("manual");
      expect(h.gate.held).toBe(1);
      await h.finished();

      expect(h.gate.released).toBe(1);
    });

    it("tells listeners about each step, from waiting to the end, and progress only goes up", async () => {
      h.runner.start("startup");
      await h.finished();

      const states = h.benchmarkEvents().map((event) => event.state);
      expect(states[0]).toBe("waiting");
      expect(states).toContain("running");
      expect(states.at(-1)).toBe("idle");
      expect(h.benchmarkEvents().at(-1)).toMatchObject({ outcome: "completed", trigger: null });
      const running = h.benchmarkEvents().filter((event) => event.state === "running");
      const progress = running.map((event) => event.progress);
      expect(progress).toEqual(progress.toSorted((a, b) => a - b));
      expect(progress.at(-1)).toBeGreaterThan(0.6);
      expect(new Set(running.flatMap((event) => event.language ?? []))).toEqual(
        new Set(["en", "uk", "ru"]),
      );
    });

    it("asks for a quiet moment on a startup run and for the pool at once on a manual one", async () => {
      const calls: string[] = [];
      const picky = h.build({
        pool: {
          hold: async () => {
            calls.push("hold");
            return () => {};
          },
          holdWhenIdle: async () => {
            calls.push("holdWhenIdle");
            return () => {};
          },
        },
      });

      picky.start("startup");
      await h.finished(picky);
      picky.start("manual");
      await h.finished(picky);

      expect(calls).toEqual(["holdWhenIdle", "hold"]);
    });

    it("says it is waiting while the pool is not free, and running only once it has it", async () => {
      let open!: () => void;
      h.gate.wait = new Promise<void>((resolve) => (open = resolve));
      h.stallEngine();

      h.runner.start("manual");
      await waitFor(() => expect(h.gate.held).toBe(1));
      expect(h.runner.status()).toMatchObject({ state: "waiting", trigger: "manual" });
      expect(h.engine.opened).toBe(0);

      open();
      await waitFor(() => expect(h.runner.status().state).toBe("running"));
      h.unstallEngine();
      await h.finished();
      expect(h.engine.opened).toBeGreaterThan(0);
    });

    it("refuses a second run while one is going on, and takes another when it is over", async () => {
      h.runner.start("manual");

      expect(() => h.runner.start("manual")).toThrow(BenchmarkBusyError);
      expect(() => h.runner.start("startup")).toThrow(BenchmarkBusyError);
      await h.finished();
      expect(() => h.runner.start("manual")).not.toThrow();
      await h.finished();
      expect(h.gate.held).toBe(2);
    });

    it("leaves no session open and no scratch folder behind", async () => {
      h.runner.start("manual");
      await h.finished();

      expect(h.engine.openSessions).toBe(0);
      expect(fs.readdirSync(h.scratch)).toEqual([]);
    });

    it("replaces the earlier results and forgets what was learned about the voice", async () => {
      h.ctx.db
        .prepare(
          "INSERT INTO speed_learning (engine, voice_id, seconds_per_kchar, slowdown, samples) VALUES ('timed', 't-en', 50, 1.4, 5)",
        )
        .run();
      h.runner.start("manual");
      await h.finished();
      const first = h.repo.get("timed", "t-en");

      expect(h.ctx.db.prepare("SELECT count(*) FROM speed_learning").pluck().get()).toBe(0);
      h.runner.start("manual");
      await h.finished();
      expect(h.repo.all("timed")).toHaveLength(3);
      expect(h.repo.get("timed", "t-en")?.secondsPerKChar).toBeCloseTo(
        first?.secondsPerKChar ?? 0,
        6,
      );
    });
  });

  describe("cancelling", () => {
    it("stops a run that is measuring, closes its sessions and saves nothing", async () => {
      h.stallEngine();
      h.runner.start("manual");
      await waitFor(() => expect(h.runner.status().state).toBe("running"));

      await h.runner.cancel();

      expect(h.runner.status()).toMatchObject({ state: "idle", outcome: "cancelled", error: null });
      expect(h.repo.all("timed")).toEqual([]);
      expect(h.engine.openSessions).toBe(0);
      expect(h.gate.released).toBe(1);
      expect(fs.readdirSync(h.scratch)).toEqual([]);
    });

    it("keeps the earlier results when a later run is cancelled", async () => {
      h.runner.start("manual");
      await h.finished();
      const before = h.repo.all("timed");
      h.machine = { ...here, cpuCount: 16 };

      h.runner.start("manual");
      await h.runner.cancel();

      expect(h.repo.all("timed")).toEqual(before);
    });

    it("stops a run that is still waiting for the pool and gives the wait up", async () => {
      h.gate.wait = new Promise<void>(() => {});
      h.runner.start("manual");
      await waitFor(() => expect(h.gate.held).toBe(1));

      await h.runner.cancel();

      expect(h.runner.status()).toMatchObject({ state: "idle", outcome: "cancelled" });
      expect(h.gate.asked[0]?.signal.aborted).toBe(true);
      expect(h.engine.opened).toBe(0);
    });

    it("says it is stopping until the engine processes are gone", async () => {
      h.stallEngine();
      h.runner.start("manual");
      await waitFor(() => expect(h.runner.status().state).toBe("running"));

      const stopping = h.runner.cancel();

      expect(h.runner.status().state).toBe("cancelling");
      await stopping;
      expect(h.benchmarkEvents().map((e) => e.state)).toContain("cancelling");
    });

    it("does nothing when nothing runs", async () => {
      await h.runner.cancel();

      expect(h.runner.status().state).toBe("idle");
      expect(h.benchmarkEvents()).toEqual([]);
    });
  });

  describe("failures", () => {
    it("saves the voices that worked when one cannot be read", async () => {
      const broken: TtsEngine = {
        id: h.engine.id,
        kind: "local",
        maxInputChars: h.engine.maxInputChars,
        voices: () => h.engine.voices(),
        async open(voiceId) {
          if (voiceId === "t-uk") throw new TtsError("engine_unavailable", "No Ukrainian model.");
          return h.engine.open(voiceId);
        },
      };
      h.runner = h.build({ engine: broken });

      h.runner.start("manual");
      await h.finished();

      expect(
        h.repo
          .all("timed")
          .map((row) => row.voiceId)
          .toSorted(),
      ).toEqual(["t-en", "t-ru"]);
      expect(h.runner.status()).toMatchObject({ outcome: "completed", error: null });
    });

    it("fails with the engine's message when no voice can be measured, and saves nothing", async () => {
      const broken: TtsEngine = {
        id: "timed",
        kind: "local",
        maxInputChars: 400,
        voices: () => h.engine.voices(),
        open: async () => {
          throw new TtsError("engine_unavailable", "Piper is not installed.");
        },
      };
      h.runner = h.build({ engine: broken });

      h.runner.start("manual");
      await h.finished();

      expect(h.runner.status()).toMatchObject({
        outcome: "failed",
        error: "Piper is not installed.",
      });
      expect(h.repo.all("timed")).toEqual([]);
      expect(h.gate.released).toBe(1);
    });

    it("fails plainly, without the technical message, for an unexpected error", async () => {
      const broken: TtsEngine = {
        id: "timed",
        kind: "local",
        maxInputChars: 400,
        voices: () => h.engine.voices(),
        open: async () => {
          throw new Error("ENOENT: /secret/path");
        },
      };
      h.runner = h.build({ engine: broken });

      h.runner.start("manual");
      await h.finished();

      expect(h.runner.status().error).toBe("The speed test could not be finished.");
    });

    it("fails when there is no voice at all", async () => {
      h.runner = h.build({ engine: new TimedEngine({ voices: [] }) });

      h.runner.start("manual");
      await h.finished();

      expect(h.runner.status()).toMatchObject({ outcome: "failed" });
      expect(h.runner.status().error).toMatch(/No voice is installed/);
    });

    it("lets the next run start after a failure", async () => {
      const stopped = h.build({
        pool: {
          hold: async () => {
            throw new Error("pool stopped");
          },
          holdWhenIdle: async () => {
            throw new Error("pool stopped");
          },
        },
      });

      stopped.start("manual");
      await h.finished(stopped);
      expect(stopped.status().outcome).toBe("failed");

      expect(() => stopped.start("manual")).not.toThrow();
      await h.finished(stopped);
    });
  });
});
