import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus, type AppEvent, type ChapterEvent, type Listener } from "./bus.js";
import { ProgressPublisher } from "./throttle.js";

const added: AppEvent = { type: "book-added", bookId: "b" };

const chapter = (progress: number, position = 1): ChapterEvent => ({
  type: "chapter",
  bookId: "b",
  position,
  status: "generating",
  progress,
  error: null,
  durationSeconds: null,
  chunkCount: 0,
  chunksDone: 0,
});
describe("EventBus", () => {
  it("delivers events to every subscriber until they unsubscribe", () => {
    const bus = new EventBus();
    const a = vi.fn<Listener>();
    const b = vi.fn<Listener>();
    const stopA = bus.subscribe(a);
    bus.subscribe(b);

    bus.publish(added);
    stopA();
    bus.publish(added);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    expect(bus.listenerCount).toBe(1);
  });

  it("numbers events from the boot time, so numbers keep growing across restarts", () => {
    const first = new EventBus(() => 1_800_000_000_000);
    const second = new EventBus(() => 1_800_000_060_000);
    const seen: number[] = [];
    first.subscribe((_event, seq) => seen.push(seq));

    first.publish(added);
    first.publish(added);

    expect(seen).toEqual([first.currentSeq - 1, first.currentSeq]);
    expect(second.currentSeq).toBeGreaterThan(first.currentSeq);
    expect(first.currentSeq).toBe((1_800_000_000_000 / 1000) * 1_000_000 + 2);
  });

  it("keeps going when a subscriber throws", () => {
    const bus = new EventBus();
    const after = vi.fn<Listener>();
    bus.subscribe(() => {
      throw new Error("closed socket");
    });
    bus.subscribe(after);

    bus.publish(added);

    expect(after).toHaveBeenCalledOnce();
  });

  it("lets a subscriber unsubscribe while an event is being delivered", () => {
    const bus = new EventBus();
    const second = vi.fn<Listener>();
    const stop = bus.subscribe(() => stop());
    bus.subscribe(second);

    bus.publish(added);

    expect(second).toHaveBeenCalledOnce();
  });
});

describe("ProgressPublisher", () => {
  let bus: EventBus;
  let seen: AppEvent[];
  let publisher: ProgressPublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
    seen = [];
    bus.subscribe((event) => seen.push(event));
    publisher = new ProgressPublisher(bus, 500);
  });

  afterEach(() => {
    publisher.stop();
    vi.useRealTimers();
  });

  const progresses = () => seen.map((e) => (e.type === "chapter" ? e.progress : null));

  it("sends the first update at once and at most one per interval after that", () => {
    publisher.progress(chapter(0.1));
    publisher.progress(chapter(0.2));
    publisher.progress(chapter(0.3));

    expect(progresses()).toEqual([0.1]);
    vi.advanceTimersByTime(499);
    expect(progresses()).toEqual([0.1]);
    vi.advanceTimersByTime(1);
    expect(progresses()).toEqual([0.1, 0.3]); // the latest value, not every one
  });

  it("sends the last value even when no further update comes", () => {
    publisher.progress(chapter(0.1));
    publisher.progress(chapter(0.9));

    vi.advanceTimersByTime(1000);

    expect(progresses()).toEqual([0.1, 0.9]);
  });

  it("throttles each chapter on its own", () => {
    publisher.progress(chapter(0.1, 1));
    publisher.progress(chapter(0.1, 2));

    expect(seen).toHaveLength(2);
  });

  it("sends a status change at once and drops the held progress that it makes obsolete", () => {
    publisher.progress(chapter(0.1));
    publisher.progress(chapter(0.5));

    publisher.publish({ ...chapter(1), status: "done" });
    vi.advanceTimersByTime(1000);

    expect(seen.map((e) => (e.type === "chapter" ? e.status : e.type))).toEqual([
      "generating",
      "done",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forgets a chapter that is no longer running, with nothing left to fire", () => {
    publisher.progress(chapter(0.1));
    publisher.progress(chapter(0.2)); // held

    publisher.forget("b", 1);
    vi.advanceTimersByTime(1000);

    expect(progresses()).toEqual([0.1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a fresh interval for a chapter that runs again", () => {
    publisher.progress(chapter(0.1));
    publisher.publish({ ...chapter(0.1), status: "queued" });

    publisher.progress(chapter(0.2));

    expect(progresses()).toEqual([0.1, 0.1, 0.2]);
  });

  it("passes other events straight through", () => {
    publisher.publish(added);

    expect(seen).toEqual([added]);
  });

  it("cancels held updates on stop", () => {
    publisher.progress(chapter(0.1));
    publisher.progress(chapter(0.2));

    publisher.stop();
    vi.advanceTimersByTime(1000);

    expect(progresses()).toEqual([0.1]);
  });
});
