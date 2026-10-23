import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHAPTER_OVERHEAD_SECONDS } from "../speed/calibration.js";
import { TEXT_PROCESSING_VERSION } from "../text/index.js";
import { createTestContext, type TestContext } from "../testing/context.js";
import { TimedEngine } from "../testing/timed-engine.js";
import { TtsCatalog } from "../tts/catalog.js";
import { BenchmarkRepository, type VoiceMeasurement } from "./repository.js";
import { IDLE_STATUS } from "./status.js";
import { toBenchmarkView } from "./view.js";

const machine = { cpuCount: 8, cpuModel: "Test CPU" };

const measurement = (
  voiceId: string,
  language: string,
  throughput: number[],
  rate = 60,
): VoiceMeasurement => ({
  engine: "timed",
  voiceId,
  language,
  secondsPerKChar: rate,
  rtf: 0.05,
  encodeFactor: 0.01,
  modelLoadMs: 250,
  throughput: throughput.map((audioPerSecond, i) => ({ workers: i + 1, audioPerSecond })),
  sampleChars: 1000,
  sampleAudioSeconds: rate,
});

describe("toBenchmarkView", () => {
  let ctx: TestContext;
  let repo: BenchmarkRepository;
  const engine = new TimedEngine({
    voices: [
      { id: "t-ru", language: "ru", name: "Ru", sampleRate: 22_050 },
      { id: "t-en", language: "en", name: "En", sampleRate: 22_050 },
    ],
  });

  beforeEach(() => {
    ctx = createTestContext();
    repo = new BenchmarkRepository(ctx.db);
  });

  afterEach(() => ctx.cleanup());

  const catalog = new TtsCatalog([engine]);

  const view = (workers = 2, thisMachine = machine) =>
    toBenchmarkView({
      catalog,
      repo,
      status: IDLE_STATUS,
      machine: thisMachine,
      workers: () => ({ current: workers, max: 12 }),
      needsRun: false,
    });

  const save = (...rows: VoiceMeasurement[]) =>
    repo.save(rows, machine, TEXT_PROCESSING_VERSION, "2026-01-01T00:00:00.000Z");

  it("lists the voices in the order of the languages, measured or not", () => {
    save(measurement("t-en", "en", [20, 30]));

    const { rows } = view();

    expect(rows.map((row) => [row.language, row.voiceId, row.result !== null])).toEqual([
      ["en", "t-en", true],
      ["ru", "t-ru", false],
    ]);
  });

  it("gives the numbers of a measured voice as the page shows them", () => {
    save(measurement("t-en", "en", [20, 30], 57));

    const result = view().rows[0]?.result;

    expect(result).toMatchObject({
      secondsPerKChar: 57,
      rtf: 0.05,
      encodeFactor: 0.01,
      modelLoadSeconds: 0.25,
      sampleChars: 1000,
      measuredAt: "2026-01-01T00:00:00.000Z",
      outdated: false,
    });
    expect(result?.throughput).toEqual([
      { workers: 1, audioPerSecond: 20 },
      { workers: 2, audioPerSecond: 30 },
    ]);
  });

  it("works out the 90,000-word novel from the speech rate of the voice", () => {
    save(measurement("t-en", "en", [20], 60));

    const result = view(1).rows[0]?.result;

    // 90,000 words of 5.8 characters at 60 s per 1,000: 31,320 s of audio.
    expect(result?.novelAudioSeconds).toBeCloseTo(31_320, 6);
    // One worker at 20 audio s/s, and the overhead of each of the 30 chapters.
    expect(result?.novelConvertSeconds).toBeCloseTo(31_320 / 20 + 30 * CHAPTER_OVERHEAD_SECONDS, 6);
  });

  it("is faster with the worker count the throughput supports, and not with more than was measured", () => {
    save(measurement("t-en", "en", [20, 30, 36]));

    const one = view(1).rows[0]?.result?.novelConvertSeconds ?? 0;
    const three = view(3).rows[0]?.result?.novelConvertSeconds ?? 0;
    const eight = view(8).rows[0]?.result?.novelConvertSeconds ?? 0;

    expect(three).toBeLessThan(one);
    expect(eight).toBeCloseTo(three, -1); // more workers than measured add nothing
  });

  it("says a result is outdated when it is from another machine or other text rules", () => {
    save(measurement("t-en", "en", [20]));

    expect(view(2, machine).rows[0]?.result?.outdated).toBe(false);
    expect(view(2, { ...machine, cpuCount: 4 }).rows[0]?.result?.outdated).toBe(true);
    expect(view(2, { ...machine, cpuModel: "Other" }).rows[0]?.result?.outdated).toBe(true);
    ctx.db.prepare("UPDATE benchmark_results SET text_version = 0").run();
    expect(view().rows[0]?.result?.outdated).toBe(true);
  });

  it("suggests the fewest workers that get close to the best throughput, over all voices", () => {
    save(
      measurement("t-en", "en", [20, 27, 29, 29.5]),
      measurement("t-ru", "ru", [19, 20, 27, 28]),
    );

    expect(view().services).toEqual([
      { id: "timed", workers: 2, maxWorkers: 12, suggestedWorkers: 3 },
    ]);
  });

  it("has no suggestion before anything was measured", () => {
    expect(view().services[0]?.suggestedWorkers).toBeNull();
  });

  it("carries the state of a run and the machine along", () => {
    const running = toBenchmarkView({
      catalog,
      repo,
      status: { ...IDLE_STATUS, state: "running", progress: 0.5, language: "en" },
      machine,
      workers: () => ({ current: 2, max: 12 }),
      needsRun: true,
    });

    expect(running).toMatchObject({
      state: "running",
      progress: 0.5,
      language: "en",
      machine,
      services: [{ id: "timed", workers: 2, maxWorkers: 12, suggestedWorkers: null }],
      needsRun: true,
    });
  });
});
