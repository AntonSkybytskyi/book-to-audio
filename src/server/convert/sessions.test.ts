import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtsError } from "../tts/engine.js";
import { FakeEngine } from "../tts/fake.js";
import { SessionHolder } from "./sessions.js";

describe("SessionHolder", () => {
  let engine: FakeEngine;

  beforeEach(() => {
    engine = new FakeEngine({
      voices: [
        { id: "fake-en", language: "en", name: "English", sampleRate: 22_050 },
        { id: "fake-uk", language: "uk", name: "Ukrainian", sampleRate: 22_050 },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens one session and reuses it", async () => {
    const holder = new SessionHolder(engine);

    await holder.synthesize("fake-en", "One.");
    await holder.synthesize("fake-en", "Two.");

    expect(engine.opened).toBe(1);
    expect(holder.isOpen).toBe(true);
    await holder.close();
    expect(engine.openSessions).toBe(0);
  });

  it("switches sessions when the voice changes, closing the old one", async () => {
    const holder = new SessionHolder(engine);

    await holder.synthesize("fake-en", "One.");
    await holder.synthesize("fake-uk", "Two.");

    expect(engine.opened).toBe(2);
    expect(engine.openSessions).toBe(1);
    await holder.close();
  });

  it("closes a session that failed, so the next call starts a new one", async () => {
    const failing = new FakeEngine({ failMarker: "[boom]" });
    const holder = new SessionHolder(failing);
    await holder.synthesize("fake-en", "Fine.");

    await expect(holder.synthesize("fake-en", "[boom]")).rejects.toBeInstanceOf(TtsError);

    expect(failing.openSessions).toBe(0);
    await holder.synthesize("fake-en", "Fine again.");
    expect(failing.opened).toBe(2);
    await holder.close();
  });

  it("closes the session after the idle time and opens another on demand", async () => {
    vi.useFakeTimers();
    const holder = new SessionHolder(engine, { idleMs: 60_000 });
    await holder.synthesize("fake-en", "One.");

    await vi.advanceTimersByTimeAsync(59_999);
    expect(holder.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(holder.isOpen).toBe(false);
    expect(engine.openSessions).toBe(0);

    await holder.synthesize("fake-en", "Two.");
    expect(engine.opened).toBe(2);
    await holder.close();
  });

  it("restarts the idle clock with every chunk", async () => {
    vi.useFakeTimers();
    const holder = new SessionHolder(engine, { idleMs: 1000 });
    await holder.synthesize("fake-en", "One.");
    await vi.advanceTimersByTimeAsync(900);
    await holder.synthesize("fake-en", "Two.");
    await vi.advanceTimersByTimeAsync(900);

    expect(holder.isOpen).toBe(true);
    await holder.close();
  });

  it("does not leave a timer behind after close", async () => {
    vi.useFakeTimers();
    const holder = new SessionHolder(engine);
    await holder.synthesize("fake-en", "One.");

    await holder.close();

    expect(vi.getTimerCount()).toBe(0);
  });
});
