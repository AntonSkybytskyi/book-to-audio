import { describe, expect, it } from "vitest";
import {
  audioSecondsFor,
  chapterWallSeconds,
  chapterWorkSeconds,
  clamp,
  conversionSeconds,
  efficiency,
  ewma,
  remainingAudio,
  suggestedWorkers,
  throughputAt,
  type SpeedModel,
} from "./estimate.js";

const model = (overrides: Partial<SpeedModel> = {}): SpeedModel => ({
  secondsPerKChar: 60,
  throughput: [
    { workers: 1, audioPerSecond: 20 },
    { workers: 2, audioPerSecond: 30 },
    { workers: 4, audioPerSecond: 40 },
  ],
  chapterOverheadSeconds: 0,
  slowdown: 1,
  source: "benchmark",
  ...overrides,
});

const chapter = (status: string, progress: number, chars = 1000) => ({
  status,
  progress,
  preparedChars: chars,
});

describe("throughputAt", () => {
  const points = model().throughput;

  it("returns a measured point as it is", () => {
    expect(throughputAt(points, 1)).toBe(20);
    expect(throughputAt(points, 2)).toBe(30);
    expect(throughputAt(points, 4)).toBe(40);
  });

  it("draws a straight line between measured points", () => {
    expect(throughputAt(points, 3)).toBe(35);
    expect(throughputAt(points, 1.5)).toBe(25);
  });

  it("stays at the last point beyond it, not guessing that more workers help", () => {
    expect(throughputAt(points, 8)).toBe(40);
  });

  it("scales below one worker and works with a single point", () => {
    expect(throughputAt(points, 0.5)).toBe(10);
    expect(throughputAt([{ workers: 1, audioPerSecond: 7 }], 3)).toBe(7);
  });

  it("does not depend on the order of the points", () => {
    expect(throughputAt(points.toReversed(), 3)).toBe(35);
  });

  it("refuses an empty curve", () => {
    expect(() => throughputAt([], 1)).toThrow(RangeError);
  });
});

describe("audio length and per-chapter times", () => {
  it("is the speech rate per 1,000 characters", () => {
    expect(audioSecondsFor(model(), 1000)).toBe(60);
    expect(audioSecondsFor(model(), 2500)).toBe(150);
    expect(audioSecondsFor(model(), -5)).toBe(0);
  });

  it("costs one worker alone the audio over its speed, plus the overhead", () => {
    expect(chapterWorkSeconds(model({ chapterOverheadSeconds: 2 }), 100)).toBe(7);
  });

  it("slows a chapter down by the efficiency at the number of busy workers", () => {
    // Two workers together make 30 audio s/s, so each does 15 against 20 alone.
    expect(efficiency(model(), 1)).toBe(1);
    expect(efficiency(model(), 2)).toBeCloseTo(0.75);
    expect(chapterWallSeconds(model(), 100, 2)).toBeCloseTo(5 / 0.75);
    expect(chapterWallSeconds(model(), 100, 0)).toBe(5); // never less than one worker
  });
});

describe("conversionSeconds", () => {
  it("is the audio over the speed for one worker", () => {
    expect(conversionSeconds(model(), [100, 100], 1)).toBe(10);
  });

  it("uses the throughput of the number of workers that are busy", () => {
    // Two chapters, two workers, 30 audio s/s together: 200 s of audio takes 6.67 s.
    expect(conversionSeconds(model(), [100, 100], 2)).toBeCloseTo(200 / 30);
  });

  it("does not use workers there is no chapter for", () => {
    expect(conversionSeconds(model(), [100], 4)).toBe(5);
  });

  it("lets the last chapters run with fewer workers, so the tail is slower than dividing", () => {
    const chapters = [100, 100, 100, 400];
    const simple = 700 / throughputAt(model().throughput, 4);
    const real = conversionSeconds(model(), chapters, 4);
    expect(real).toBeGreaterThan(simple);
    // Four busy workers make 10 audio s/s each, so the three short chapters are done after 10 s.
    // The long one has 300 s of audio left and then has the machine to itself: 20 audio s/s.
    expect(real).toBeCloseTo(10 + 300 / 20);
  });

  it("adds the overhead of every chapter", () => {
    expect(conversionSeconds(model({ chapterOverheadSeconds: 1 }), [100, 100], 1)).toBe(12);
  });

  it("multiplies by what was learned about the machine being slower or faster", () => {
    expect(conversionSeconds(model({ slowdown: 1.5 }), [100, 100], 1)).toBe(15);
    expect(conversionSeconds(model({ slowdown: 0.5 }), [100, 100], 1)).toBe(5);
  });

  it("is zero when nothing is left, and ignores empty chapters", () => {
    expect(conversionSeconds(model(), [], 3)).toBe(0);
    expect(conversionSeconds(model(), [0, 0], 3)).toBe(0);
  });

  it("treats a worker count below one as one", () => {
    expect(conversionSeconds(model(), [100], 0)).toBe(5);
  });

  it("takes the next chapter in the order given when a worker frees up", () => {
    // One short and two long chapters on two workers: the second long one waits for the short one.
    const seconds = conversionSeconds(model(), [30, 200, 200], 2);
    expect(seconds).toBeGreaterThan(conversionSeconds(model(), [200, 200], 2));
  });
});

describe("remainingAudio", () => {
  const m = model();

  it("counts a running chapter by what is left of it and a waiting one in full", () => {
    expect(remainingAudio(m, [chapter("generating", 0.25), chapter("queued", 0)])).toEqual([
      45, 60,
    ]);
  });

  it("puts running chapters first, then the waiting ones in order", () => {
    const rest = remainingAudio(m, [
      chapter("queued", 0, 1000),
      chapter("generating", 0.5, 2000),
      chapter("pending", 0, 500),
    ]);
    expect(rest).toEqual([60, 60, 30]);
  });

  it("leaves out finished and failed chapters", () => {
    expect(
      remainingAudio(m, [chapter("done", 1), chapter("failed", 0.3), chapter("queued", 0)]),
    ).toEqual([60]);
  });

  it("keeps a progress outside 0 to 1 sensible", () => {
    expect(remainingAudio(m, [chapter("generating", 1.5)])).toEqual([0]);
  });
});

describe("ewma", () => {
  it("moves half way on the first sample, then settles on a steady weight", () => {
    expect(ewma(10, 20, 0)).toBe(15);
    expect(ewma(10, 20, 2)).toBe(12.5);
    expect(ewma(10, 20, 100)).toBe(12.5);
  });

  it("converges on a steady value", () => {
    let value = 1;
    for (let i = 0; i < 40; i++) value = ewma(value, 2, i);
    expect(value).toBeCloseTo(2, 3);
  });
});

describe("clamp and suggestedWorkers", () => {
  it("clamps", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });

  it("suggests the fewest workers within 5% of the best", () => {
    const points = [
      { workers: 1, audioPerSecond: 20 },
      { workers: 2, audioPerSecond: 26 },
      { workers: 3, audioPerSecond: 29 },
      { workers: 4, audioPerSecond: 29.5 },
    ];
    expect(suggestedWorkers(points)).toBe(3);
  });

  it("suggests one when more workers do not help", () => {
    expect(
      suggestedWorkers([
        { workers: 1, audioPerSecond: 20 },
        { workers: 2, audioPerSecond: 20.5 },
      ]),
    ).toBe(1);
  });
});
