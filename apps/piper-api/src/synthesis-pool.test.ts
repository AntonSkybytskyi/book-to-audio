import { afterEach, describe, expect, it, vi } from "vitest";
import { TtsError } from "./errors.js";
import { SynthesisPool, type Session } from "./synthesis-pool.js";
import type { PcmAudio } from "./wav.js";

interface FakeSession extends Session {
  voiceId: string;
  closed: boolean;
}

/** Sessions whose chunks finish only when the test says so. */
function fakes() {
  const sessions: FakeSession[] = [];
  const pending: { text: string; finish(error?: Error): void }[] = [];
  const open = vi.fn<(voiceId: string) => Promise<Session>>(async (voiceId) => {
    const session: FakeSession = {
      voiceId,
      closed: false,
      synthesize: (text: string, signal?: AbortSignal) =>
        new Promise<PcmAudio>((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new TtsError("aborted", "cancelled")));
          pending.push({
            text,
            finish: (error) =>
              error
                ? reject(error)
                : resolve({ sampleRate: 22050, channels: 1, samples: Buffer.from(text) }),
          });
        }),
      close: async () => {
        session.closed = true;
        for (const p of pending.splice(0)) p.finish(new TtsError("aborted", "closed"));
      },
    };
    sessions.push(session);
    return session;
  });
  /** Finishes the oldest chunk in flight. */
  const finish = async (error?: Error) => {
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    pending.shift()?.finish(error);
  };
  return { sessions, pending, open, finish };
}

const VOICES = new Set(["en", "uk", "ru"]);
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("SynthesisPool", () => {
  let pool: SynthesisPool;
  afterEach(() => pool.close());

  const make = (concurrency: number, f = fakes(), idleMs = 60_000) => {
    pool = new SynthesisPool({ concurrency, idleMs, has: (v) => VOICES.has(v), open: f.open });
    return f;
  };

  it("reuses a warm session for the next chunk of the same voice", async () => {
    const f = make(2);

    const first = pool.synthesize("en", "One.");
    await f.finish();
    await first;
    const second = pool.synthesize("en", "Two.");
    await f.finish();

    expect((await second).samples.toString()).toBe("Two.");
    expect(f.open).toHaveBeenCalledTimes(1);
  });

  it("runs at most `concurrency` chunks at once and serves the rest in order", async () => {
    const f = make(2);
    const done: string[] = [];
    const run = (text: string) => pool.synthesize("en", text).then(() => done.push(text));

    const all = Promise.all([run("a"), run("b"), run("c"), run("d")]);
    await vi.waitFor(() => expect(f.pending).toHaveLength(2));
    await flush();
    expect(f.pending.map((p) => p.text)).toEqual(["a", "b"]);

    await f.finish();
    await vi.waitFor(() => expect(f.pending.map((p) => p.text)).toEqual(["b", "c"]));
    await f.finish();
    await f.finish();
    await f.finish();
    await all;

    expect(done).toEqual(["a", "b", "c", "d"]);
    expect(f.open).toHaveBeenCalledTimes(2);
  });

  it("closes the session idle the longest when a new voice needs room", async () => {
    const f = make(2);
    for (const voice of ["en", "uk"]) {
      const chunk = pool.synthesize(voice, "x");
      await f.finish();
      await chunk;
    }

    const ru = pool.synthesize("ru", "x");
    await f.finish();
    await ru;

    expect(f.sessions.map((s) => [s.voiceId, s.closed])).toEqual([
      ["en", true],
      ["uk", false],
      ["ru", false],
    ]);
    expect(pool.sessions).toBe(2);
  });

  it("counts sessions that are still starting, so two new voices at once do not pass the limit", async () => {
    const f = make(2);
    const en = pool.synthesize("en", "x");
    await f.finish();
    await en;

    const uk = pool.synthesize("uk", "x");
    const ru = pool.synthesize("ru", "x");
    await vi.waitFor(() => expect(f.pending).toHaveLength(2));

    expect(f.sessions.filter((s) => !s.closed)).toHaveLength(2);
    await f.finish();
    await f.finish();
    await Promise.all([uk, ru]);
    expect(pool.sessions).toBe(2);
  });

  it("drops a waiting request whose client went away", async () => {
    const f = make(1);
    const first = pool.synthesize("en", "first");
    const controller = new AbortController();
    const waiting = pool.synthesize("en", "waiting", controller.signal);
    const last = pool.synthesize("en", "last");

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    await f.finish();
    await first;
    await vi.waitFor(() => expect(f.pending.map((p) => p.text)).toEqual(["last"]));
    await f.finish();
    await last;
  });

  it("closes a session that failed and opens a new one for the next chunk", async () => {
    const f = make(1);

    const failed = pool.synthesize("en", "x");
    await f.finish(new TtsError("synthesis_failed", "crashed"));
    await expect(failed).rejects.toMatchObject({ code: "synthesis_failed" });
    const next = pool.synthesize("en", "y");
    await f.finish();
    await next;

    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.sessions[0]?.closed).toBe(true);
  });

  it("frees the slot when a session cannot be started", async () => {
    const f = fakes();
    f.open.mockRejectedValueOnce(new TtsError("engine_unavailable", "not installed"));
    make(1, f);

    await expect(pool.synthesize("en", "x")).rejects.toMatchObject({ code: "engine_unavailable" });
    const next = pool.synthesize("en", "y");
    await f.finish();

    await expect(next).resolves.toBeDefined();
  });

  it("refuses an unknown voice without waiting for a slot", async () => {
    const f = make(1);
    const busy = pool.synthesize("en", "x");

    await expect(pool.synthesize("de", "x")).rejects.toMatchObject({ code: "voice_not_found" });
    await f.finish();
    await busy;
  });

  it("closes a session nobody used for `idleMs`", async () => {
    const f = make(1, fakes(), 20);
    const chunk = pool.synthesize("en", "x");
    await f.finish();
    await chunk;

    await vi.waitFor(() => expect(f.sessions[0]?.closed).toBe(true));
    expect(pool.sessions).toBe(0);
  });

  it("stops waiting requests and every session on close", async () => {
    const f = make(1);
    const running = pool.synthesize("en", "x");
    const waiting = pool.synthesize("en", "y");
    await vi.waitFor(() => expect(f.pending).toHaveLength(1));

    await pool.close();

    await expect(running).rejects.toMatchObject({ code: "aborted" });
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    expect(f.sessions[0]?.closed).toBe(true);
  });
});
