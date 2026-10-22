import { describe, expect, it, vi } from "vitest";
import { TEXT_PROCESSING_VERSION } from "../text/index.js";
import { TimedEngine } from "../testing/timed-engine.js";
import { here, useRunnerHarness, VOICES } from "../testing/runner-harness.js";
import { BenchmarkStoppedError } from "./runner.js";

describe("BenchmarkRunner: when a run is due", () => {
  const h = useRunnerHarness();

  describe("needsRun and startIfNeeded", () => {
    it("is needed before anything was measured", () => {
      expect(h.runner.needsRun()).toBe(true);
    });

    it("is not needed once every voice has a result from this machine", async () => {
      h.runner.start("manual");
      await h.finished();

      expect(h.runner.needsRun()).toBe(false);
      expect(h.runner.startIfNeeded()).toBe(false);
      expect(h.runner.status().state).toBe("idle");
    });

    it("is needed again when the machine changed", async () => {
      h.runner.start("manual");
      await h.finished();

      h.machine = { ...here, cpuCount: 4 };
      expect(h.runner.needsRun()).toBe(true);
      h.machine = { ...here, cpuModel: "Another CPU" };
      expect(h.runner.needsRun()).toBe(true);
    });

    it("is needed again when the text rules changed", async () => {
      h.runner.start("manual");
      await h.finished();

      h.ctx.db.prepare("UPDATE benchmark_results SET text_version = text_version - 1").run();

      expect(h.runner.needsRun()).toBe(true);
    });

    it("is needed when a voice has no result, for example one that was installed since", async () => {
      h.runner.start("manual");
      await h.finished();
      h.engine = new TimedEngine({
        voices: [...VOICES.slice(0, 2), { ...VOICES[2]!, id: "t-ru-new" }],
      });
      h.runner = h.build();

      expect(h.runner.needsRun()).toBe(true);
    });

    it("looks only at the results of this engine", () => {
      h.ctx.db
        .prepare(
          `INSERT INTO benchmark_results (engine, voice_id, language, seconds_per_kchar, rtf, encode_factor,
             model_load_ms, throughput, sample_chars, sample_audio_seconds, cpu_count, cpu_model, text_version, measured_at)
           VALUES ('piper', 't-en', 'en', 60, 0.1, NULL, 1, '[]', 1, 1, 8, 'Test CPU', ?, 'x')`,
        )
        .run(TEXT_PROCESSING_VERSION);

      expect(h.runner.needsRun()).toBe(true);
    });

    it("needs nothing when there are no voices", () => {
      h.runner = h.build({ engine: new TimedEngine({ voices: [] }) });

      expect(h.runner.needsRun()).toBe(false);
      expect(h.runner.startIfNeeded()).toBe(false);
    });

    it("starts a startup run, which waits for the pool to be idle, when something is due", async () => {
      expect(h.runner.startIfNeeded()).toBe(true);
      expect(h.runner.status()).toMatchObject({ trigger: "startup" });
      await h.finished();

      expect(h.repo.all("timed")).toHaveLength(3);
      expect(h.runner.startIfNeeded()).toBe(false);
    });

    it("does not start a second run on top of one that is going on", async () => {
      h.runner.start("manual");

      expect(h.runner.startIfNeeded()).toBe(false);
      await h.finished();
    });
  });

  describe("when the computer was busy", () => {
    it("remembers how busy it was when the run began and ended, and how long it took", async () => {
      h.load = 3.5;
      h.stallEngine();

      h.runner.start("manual");
      await vi.waitFor(() => expect(h.runner.status().state).toBe("running"));
      h.load = 9;
      h.unstallEngine();
      await h.finished();

      const row = h.repo.get("timed", "t-en");
      expect(row).toMatchObject({ loadStart: 3.5, loadAttempt: 1 });
      expect(row?.loadEnd).toBe(9);
      expect(row?.seconds).toBeGreaterThan(0);
    });

    it("is not due again after a run that began quietly", async () => {
      h.load = 2; // fewer than the 8 cores

      h.runner.start("manual");
      await h.finished();

      expect(h.runner.needsRun()).toBe(false);
    });

    it("is due once more after a run that began on a busy computer, and then not again", async () => {
      h.load = 20; // more than the 8 cores

      h.runner.start("manual");
      await h.finished();
      expect(h.runner.needsRun()).toBe(true);
      expect(h.runner.startIfNeeded()).toBe(true);
      await h.finished();

      expect(h.repo.get("timed", "t-en")?.loadAttempt).toBe(2);
      expect(h.runner.needsRun()).toBe(false);
    });

    it("starts counting afresh after a run that began quietly", async () => {
      h.load = 20;
      h.runner.start("manual");
      await h.finished();
      h.load = 1;
      h.runner.start("manual");
      await h.finished();

      expect(h.repo.get("timed", "t-en")?.loadAttempt).toBe(1);
      expect(h.runner.needsRun()).toBe(false);
    });
  });

  describe("the load a run is judged by", () => {
    it("is the one when the run was asked for, not what the app's own chapters made of it while it waited", async () => {
      h.load = 2;
      let open!: () => void;
      h.gate.wait = new Promise<void>((resolve) => (open = resolve));

      h.runner.start("startup");
      h.load = 30; // conversions ran while it waited for a quiet moment
      open();
      await h.finished();

      expect(h.repo.get("timed", "t-en")).toMatchObject({ loadStart: 2, loadAttempt: 1 });
      expect(h.runner.needsRun()).toBe(false);
    });
  });

  describe("how long it is expected to take", () => {
    it("is a guess until a run was timed, and nothing while idle", () => {
      expect(h.runner.expectedRemainingSeconds()).toBeNull();
      expect(h.runner.status().expectedSeconds).toBe(180);
    });

    it("is the whole of it while waiting, and what is left of it while running", async () => {
      h.gate.wait = new Promise<void>(() => {});
      h.runner.start("manual");
      expect(h.runner.expectedRemainingSeconds()).toBe(180);

      h.gate.wait = null;
      await h.runner.cancel();
      h.stallEngine();
      h.runner.start("manual");
      await vi.waitFor(() => expect(h.runner.status().state).toBe("running"));

      expect(h.runner.expectedRemainingSeconds()).toBe(180); // nothing measured yet
    });

    it("is what the last run took", async () => {
      h.runner.start("manual");
      await h.finished();
      const took = h.repo.get("timed", "t-en")?.seconds ?? 0;

      expect(h.runner.status().expectedSeconds).toBeCloseTo(took, 6);
      expect(h.runner.expectedRemainingSeconds()).toBeNull();
    });
  });

  describe("a start by hand while the first-start run waits for a quiet moment", () => {
    it("takes the run over and asks for the pool at once, instead of being refused", async () => {
      h.gate.wait = new Promise<void>(() => {}); // the pool never gets quiet
      h.runner.start("startup");
      await vi.waitFor(() => expect(h.gate.asked).toHaveLength(1));
      expect(h.gate.asked[0]?.kind).toBe("holdWhenIdle");

      const status = h.runner.start("manual");

      expect(status).toMatchObject({ state: "waiting", trigger: "manual" });
      await vi.waitFor(() => expect(h.gate.asked).toHaveLength(2));
      expect(h.gate.asked[1]?.kind).toBe("hold");
      expect(h.gate.asked[0]?.signal.aborted).toBe(true);
      expect(h.gate.asked[1]?.signal.aborted).toBe(false);
      h.gate.wait = null;
      await h.runner.cancel();
    });

    it("then runs to the end like any run", async () => {
      let open!: () => void;
      h.gate.wait = new Promise<void>((resolve) => (open = resolve));
      h.runner.start("startup");
      await vi.waitFor(() => expect(h.gate.asked).toHaveLength(1));
      h.runner.start("manual");
      await vi.waitFor(() => expect(h.gate.asked).toHaveLength(2));

      open();
      await h.finished();

      expect(h.runner.status()).toMatchObject({ outcome: "completed" });
      expect(h.repo.all("timed")).toHaveLength(3);
      expect(h.gate.released).toBeGreaterThanOrEqual(1);
    });

    it("still refuses a second start by hand, and a start while it is already measuring", async () => {
      h.stallEngine();
      h.runner.start("startup");
      await vi.waitFor(() => expect(h.runner.status().state).toBe("running"));

      expect(() => h.runner.start("manual")).toThrow(/already running/);
    });

    it("does not take over twice", async () => {
      h.gate.wait = new Promise<void>(() => {});
      h.runner.start("startup");
      await vi.waitFor(() => expect(h.gate.asked).toHaveLength(1));
      h.runner.start("manual");

      expect(() => h.runner.start("manual")).toThrow(/already running/);
      h.gate.wait = null;
      await h.runner.cancel();
    });
  });

  describe("shutdown", () => {
    it("cancels a run that is under way and refuses to start another", async () => {
      h.stallEngine();
      h.runner.start("manual");
      await vi.waitFor(() => expect(h.runner.status().state).toBe("running"));

      await h.runner.shutdown();

      expect(h.runner.status()).toMatchObject({ state: "idle", outcome: "cancelled" });
      expect(h.engine.openSessions).toBe(0);
      expect(() => h.runner.start("manual")).toThrow(BenchmarkStoppedError);
      expect(() => h.runner.start("startup")).toThrow(BenchmarkStoppedError);
    });

    it("does not let the first-start run begin after it, even though a run is due", async () => {
      expect(h.runner.needsRun()).toBe(true);

      await h.runner.shutdown();

      expect(h.runner.startIfNeeded()).toBe(false);
      expect(h.runner.status().state).toBe("idle");
      expect(h.gate.asked).toEqual([]);
    });

    it("refuses at once, before it has finished stopping", async () => {
      h.stallEngine();
      h.runner.start("manual");
      await vi.waitFor(() => expect(h.runner.status().state).toBe("running"));

      const stopping = h.runner.shutdown();

      expect(() => h.runner.start("manual")).toThrow(BenchmarkStoppedError);
      expect(h.runner.startIfNeeded()).toBe(false);
      await stopping;
    });

    it("is safe to call when nothing runs, and twice", async () => {
      await h.runner.shutdown();
      await h.runner.shutdown();

      expect(h.runner.status().state).toBe("idle");
    });
  });
});
