import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SynthesisPool } from "./synthesis-pool.js";
import { buildServer } from "./server.js";
import { alive, usePiperFixture, VOICE } from "./testing/piper-fixture.js";

describe("the TTS service API", () => {
  const fixture = usePiperFixture();
  let app: FastifyInstance;
  let pool: SynthesisPool;
  let problem: string | null;

  beforeEach(() => {
    const engine = fixture.engineWith(500);
    pool = new SynthesisPool({
      concurrency: 2,
      idleMs: 60_000,
      has: (id) => engine.has(id),
      open: (id) => engine.open(id),
    });
    problem = null;
    app = buildServer({
      voices: () => engine.voices(),
      pool,
      maxInputChars: 20,
      concurrency: 2,
      problem: () => problem,
    });
  });

  afterEach(async () => {
    await pool.close();
    await app.close();
  });

  const synthesize = (body: unknown) =>
    app.inject({ method: "POST", url: "/synthesize", payload: body as object });

  it("answers health checks, and says why it is not ready", async () => {
    expect((await app.inject("/health")).json()).toEqual({ status: "ok" });

    problem = "No voices are installed in /opt/piper-voices.";
    const response = await app.inject("/health");

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "error", reason: problem });
  });

  it("lists its voices with its limits", async () => {
    expect((await app.inject("/voices")).json()).toEqual({
      voices: [{ id: VOICE, language: "en", name: VOICE, sampleRate: 22050 }],
      maxInputChars: 20,
      concurrency: 2,
    });
  });

  it("returns the audio as a 16-bit mono WAV", async () => {
    const response = await synthesize({ voice: VOICE, text: "Hello world." });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("audio/wav");
    const wav = response.rawPayload;
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(22050);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe("Hello world.".length * 2);
    expect(wav.length).toBe(44 + "Hello world.".length * 2);
  });

  it.each([
    ["an unknown voice", { voice: "nope", text: "Hi." }, 404, "voice_not_found"],
    ["an empty text", { voice: VOICE, text: "" }, 422, "bad_input"],
    ["a text longer than maxInputChars", { voice: VOICE, text: "x".repeat(21) }, 422, "bad_input"],
    ["a missing field", { voice: VOICE }, 422, "bad_input"],
    ["an extra field", { voice: VOICE, text: "Hi.", speed: 2 }, 422, "bad_input"],
    ["a text that gives no audio", { voice: VOICE, text: "EMPTY" }, 422, "bad_input"],
    ["a crash", { voice: VOICE, text: "CRASH" }, 500, "synthesis_failed"],
    ["a chunk that takes too long", { voice: VOICE, text: "HANG" }, 504, "timeout"],
  ])("answers %s with its error code", async (_name, body, status, code) => {
    const response = await synthesize(body);

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code, message: expect.any(String) });
  });

  it("answers a body that is not JSON with bad_input", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/synthesize",
      headers: { "content-type": "application/json" },
      payload: "{",
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "bad_input" });
  });

  it("answers 503 without an error code when it stops while the client still waits", async () => {
    const response = synthesize({ voice: VOICE, text: "HANG" });
    await vi.waitFor(() => expect(fixture.starts()).toHaveLength(1));

    await pool.close();

    expect((await response).statusCode).toBe(503);
    expect((await response).json()).toEqual({ status: "stopping" });
  });

  it("keeps stderr in the detail, out of the message", async () => {
    const response = await synthesize({ voice: VOICE, text: "CRASH" });

    expect(response.json()).toEqual({
      code: "synthesis_failed",
      message: "The speech engine stopped unexpectedly.",
      detail: expect.stringContaining("bad model"),
    });
  });

  it("stops Piper when the client hangs up", async () => {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/synthesize",
      headers: { "content-type": "application/json" },
    });
    request.on("error", () => {});
    request.end(JSON.stringify({ voice: VOICE, text: "HANG" }));

    await vi.waitFor(() => expect(fixture.starts()).toHaveLength(1));
    const [{ pid } = { pid: 0 }] = fixture.starts();
    request.destroy();

    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    expect(pool.sessions).toBe(0);
  });
});
