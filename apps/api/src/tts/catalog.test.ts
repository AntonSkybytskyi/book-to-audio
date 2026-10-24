import { describe, expect, it, vi } from "vitest";
import { FakeEngine } from "../testing/fake-engine.js";
import { TtsCatalog } from "./catalog.js";
import type { Voice } from "./engine.js";

const voice = (id: string, language: string): Voice => ({
  id,
  language,
  name: id,
  sampleRate: 22_050,
});

const piper = () =>
  new FakeEngine({
    id: "piper",
    maxInputChars: 1000,
    voices: [voice("piper:en", "en"), voice("piper:uk", "uk"), voice("piper:uk-2", "uk")],
  });
const other = () =>
  new FakeEngine({
    id: "other",
    maxInputChars: 300,
    voices: [voice("other:uk", "uk"), voice("other:ru", "ru")],
  });

/** An engine that answers `refresh` like an HTTP one: voices only once it has answered. */
class Remote extends FakeEngine {
  ready = false;
  override reachable = false;
  answers = true;
  lastError: { message: string; detail?: string } | undefined;
  refresh = vi.fn<() => Promise<boolean>>(async () => {
    const before = this.reachable;
    this.reachable = this.answers;
    if (this.answers) this.ready = true;
    return before !== this.reachable;
  });
  override voices(): Voice[] {
    return this.ready ? super.voices() : [];
  }
}

describe("TtsCatalog", () => {
  it("lists every service's voices, services in order, each with its engine", () => {
    const catalog = new TtsCatalog([piper(), other()]);

    expect(catalog.voices().map((v) => [v.id, v.engine])).toEqual([
      ["piper:en", "piper"],
      ["piper:uk", "piper"],
      ["piper:uk-2", "piper"],
      ["other:uk", "other"],
      ["other:ru", "other"],
    ]);
    expect(catalog.engineOfVoice("other:ru")?.id).toBe("other");
  });

  it("reads a language with the first voice for it, services in order", () => {
    const catalog = new TtsCatalog([piper(), other()]);

    expect(catalog.voiceFor("uk")?.id).toBe("piper:uk");
    expect(catalog.voiceFor("ru")?.id).toBe("other:ru");
    expect(catalog.voiceFor("de")).toBeUndefined();
    expect(catalog.availableLanguages()).toEqual(["en", "uk", "ru"]);
  });

  it("reads a language with the voice the owner chose, from any service", () => {
    const chosen: Record<string, string> = { uk: "other:uk", en: "piper:uk" };
    const catalog = new TtsCatalog([piper(), other()], { chosenVoice: (l) => chosen[l] });

    expect(catalog.voiceFor("uk")?.id).toBe("other:uk");
    // A voice of another language is not used, nor a voice that is gone.
    expect(catalog.voiceFor("en")?.id).toBe("piper:en");
    chosen.uk = "other:gone";
    expect(catalog.voiceFor("uk")?.id).toBe("piper:uk");
  });

  it("gives each service the languages its voices read, and splits text for that service", () => {
    const catalog = new TtsCatalog([piper(), other()], {
      chosenVoice: (l) => (l === "uk" ? "other:uk" : undefined),
    });

    expect(catalog.languagesOn("piper")).toEqual(["en"]);
    expect(catalog.languagesOn("other")).toEqual(["uk", "ru"]);
    expect(catalog.maxCharsFor("uk")).toBe(300);
    expect(catalog.maxCharsFor("en")).toBe(1000);
    expect(catalog.maxCharsFor("de")).toBe(1000);
  });

  it("waits for a chosen voice whose service has not answered yet instead of using another", async () => {
    const remote = new Remote({ id: "remote", voices: [voice("remote:uk", "uk")] });
    const catalog = new TtsCatalog([piper(), remote], {
      chosenVoice: (l) => (l === "uk" ? "remote:uk" : undefined),
    });

    expect(catalog.voiceFor("uk")).toBeUndefined();
    expect(catalog.languagesOn("piper")).toEqual(["en"]);

    await catalog.refresh();

    expect(catalog.voiceFor("uk")?.id).toBe("remote:uk");
  });

  it("asks the services again and tells listeners when something changed", async () => {
    const remote = new Remote({ id: "remote", voices: [voice("remote:uk", "uk")] });
    const catalog = new TtsCatalog([piper(), remote]);
    const changed = vi.fn<() => void>();
    catalog.onChange(changed);

    await catalog.refresh();
    await catalog.refresh();
    remote.answers = false;
    await catalog.refresh("remote");

    expect(remote.refresh).toHaveBeenCalledTimes(3);
    expect(changed).toHaveBeenCalledTimes(2); // answered, then stopped answering
  });

  it("logs why a service does not answer, once for each reason", async () => {
    const remote = new Remote({ id: "remote", voices: [voice("remote:uk", "uk")] });
    remote.answers = false;
    remote.lastError = { message: "Not reachable.", detail: "GET /voices: ECONNREFUSED" };
    const logger = {
      info: vi.fn<(m: string) => void>(),
      warn: vi.fn<(context: object, m: string) => void>(),
    };
    const catalog = new TtsCatalog([remote], { logger });

    await catalog.refresh();
    await catalog.refresh();
    remote.lastError = { message: "Failed.", detail: "HTTP 404" };
    await catalog.refresh();
    remote.answers = true;
    await catalog.refresh();
    await catalog.refresh();

    expect(logger.warn.mock.calls).toEqual([
      [{ detail: "GET /voices: ECONNREFUSED" }, 'TTS service "remote" does not answer'],
      [{ detail: "HTTP 404" }, 'TTS service "remote" does not answer'],
    ]);
    expect(logger.info.mock.calls).toEqual([['TTS service "remote" answers, 1 voices']]);
  });

  it("logs once when a chosen voice is gone and another voice reads the language", async () => {
    const remote = new Remote({ id: "remote", voices: [voice("remote:uk", "uk")] });
    const logger = { info: vi.fn<(m: string) => void>() };
    const catalog = new TtsCatalog([piper(), remote], {
      logger,
      chosenVoice: (l) => (l === "uk" ? "remote:gone" : undefined),
    });

    await catalog.refresh();
    remote.answers = false;
    await catalog.refresh();

    expect(logger.info.mock.calls.filter(([m]) => m.includes("chosen"))).toEqual([
      [
        'the chosen voice "remote:gone" for uk is not available, piper:uk reads it until it is back',
      ],
    ]);
  });

  it("keeps polling when a listener fails, and asks a service again soon when told it went away", async () => {
    vi.useFakeTimers();
    try {
      const remote = new Remote({ id: "remote" });
      const catalog = new TtsCatalog([remote], { pollMs: 1000, downPollMs: 100 });
      catalog.onChange(() => {
        throw new Error("listener broke");
      });
      catalog.start();
      await vi.advanceTimersByTimeAsync(100); // answers: a change, and the listener throws
      await vi.advanceTimersByTimeAsync(1000);
      expect(remote.refresh).toHaveBeenCalledTimes(2);

      remote.reachable = false; // a request found it gone
      catalog.checkSoon("remote");
      await vi.advanceTimersByTimeAsync(100);
      expect(remote.refresh).toHaveBeenCalledTimes(3);
      catalog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling: often while a service is down, rarely once it answers", async () => {
    vi.useFakeTimers();
    try {
      const remote = new Remote({ id: "remote" });
      remote.answers = false;
      const catalog = new TtsCatalog([remote], { pollMs: 1000, downPollMs: 100 });

      catalog.start();
      await vi.advanceTimersByTimeAsync(350);
      expect(remote.refresh).toHaveBeenCalledTimes(3);

      remote.answers = true;
      await vi.advanceTimersByTimeAsync(100); // the fourth answers
      await vi.advanceTimersByTimeAsync(900);
      expect(remote.refresh).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(100);
      expect(remote.refresh).toHaveBeenCalledTimes(5);

      catalog.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(remote.refresh).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
