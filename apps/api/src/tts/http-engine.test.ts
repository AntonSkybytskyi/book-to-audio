import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpTtsEngine } from "./http-engine.js";

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

const wav = (samples: number[], sampleRate = 22050) => {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

const VOICES = {
  voices: [
    { id: "en_US-lessac-medium", language: "en", name: "Lessac", sampleRate: 22050 },
    { id: "uk:lada", language: "uk", name: "Lada", sampleRate: 22050, speaker: "lada" },
  ],
  maxInputChars: 800,
  concurrency: 3,
};

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("HttpTtsEngine", () => {
  let server: http.Server;
  let baseUrl: string;
  let handler: Handler;
  const requests: { method?: string; url?: string; body: string }[] = [];

  const listen = async (port = 0) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body });
        handler(req, body, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  };

  beforeEach(async () => {
    requests.length = 0;
    handler = (req, _body, res) => {
      if (req.url === "/voices") return json(res, 200, VOICES);
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(wav([1, 2, 3]));
    };
    baseUrl = `http://127.0.0.1:${await listen()}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const engine = (options: Partial<ConstructorParameters<typeof HttpTtsEngine>[0]> = {}) =>
    new HttpTtsEngine({ id: "piper", baseUrl, retryDelaysMs: [0, 0], ...options });

  const ready = async (options?: Parameters<typeof engine>[0]) => {
    const e = engine(options);
    await e.refresh();
    return e;
  };

  describe("voices", () => {
    it("has none and is not ready before the service answered", () => {
      const e = engine();

      expect(e.voices()).toEqual([]);
      expect([e.ready, e.reachable]).toEqual([false, false]);
    });

    it("puts the service name in front of each voice id and takes its limits", async () => {
      const e = engine();

      expect(await e.refresh()).toBe(true);

      expect(e.voices()).toEqual([
        { id: "piper:en_US-lessac-medium", language: "en", name: "Lessac", sampleRate: 22050 },
        { id: "piper:uk:lada", language: "uk", name: "Lada", sampleRate: 22050, speaker: "lada" },
      ]);
      expect([e.maxInputChars, e.concurrency, e.ready, e.reachable]).toEqual([800, 3, true, true]);
      expect(await e.refresh()).toBe(false); // nothing changed
    });

    it("keeps the voices it knows when the service stops answering", async () => {
      const e = await ready();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));

      expect(await e.refresh()).toBe(true);

      expect(e.voices()).toHaveLength(2);
      expect([e.ready, e.reachable]).toEqual([true, false]);
    });

    it("drops voices it cannot read, and refuses a list without limits", async () => {
      handler = (_req, _body, res) =>
        json(res, 200, {
          ...VOICES,
          voices: [...VOICES.voices, { id: 7 }, { id: "x", language: "en" }],
        });
      const e = await ready();
      expect(e.voices()).toHaveLength(2);

      handler = (_req, _body, res) => json(res, 200, { voices: [] });
      await e.refresh();
      expect(e.reachable).toBe(false);
    });
  });

  describe("synthesize", () => {
    it("sends the voice id without the service name and decodes the WAV", async () => {
      const e = await ready();
      const session = await e.open("piper:uk:lada");

      const audio = await session.synthesize("Привіт.");

      expect(requests.at(-1)).toEqual({
        method: "POST",
        url: "/synthesize",
        body: JSON.stringify({ voice: "uk:lada", text: "Привіт." }),
      });
      expect(audio).toEqual({
        sampleRate: 22050,
        channels: 1,
        samples: wav([1, 2, 3]).subarray(44),
      });
    });

    it("refuses a voice it does not have, and opens nothing before the service answered", async () => {
      await expect((await ready()).open("piper:nope")).rejects.toMatchObject({
        code: "voice_not_found",
      });
      await expect(engine().open("piper:uk:lada")).rejects.toMatchObject({ code: "unreachable" });
    });

    it.each(["voice_not_found", "bad_input", "synthesis_failed", "timeout", "engine_unavailable"])(
      "passes on the service's %s with its message and detail",
      async (code) => {
        const e = await ready();
        handler = (_req, _body, res) =>
          json(res, 500, { code, message: "It broke.", detail: "stderr" });

        await expect((await e.open("piper:uk:lada")).synthesize("Hi.")).rejects.toMatchObject({
          code,
          message: "It broke.",
          detail: "HTTP 500: stderr",
        });
      },
    );

    it.each([
      [503, "unreachable"],
      [502, "unreachable"],
      [500, "synthesis_failed"],
      [404, "synthesis_failed"],
    ])("reads HTTP %i without the API's error body as %s", async (status, code) => {
      const e = await ready();
      handler = (_req, _body, res) => {
        res.writeHead(status);
        res.end("<html>nope</html>");
      };

      await expect((await e.open("piper:uk:lada")).synthesize("Hi.")).rejects.toMatchObject({
        code,
      });
    });

    it("refuses audio that is not a WAV", async () => {
      const e = await ready();
      handler = (_req, _body, res) => {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        res.end("ID3");
      };

      await expect((await e.open("piper:uk:lada")).synthesize("Hi.")).rejects.toMatchObject({
        code: "synthesis_failed",
      });
    });

    it("tries again when the connection breaks before an answer, and only then", async () => {
      const e = await ready();
      let calls = 0;
      handler = (req, _body, res) => {
        calls++;
        if (calls < 3) return req.socket.destroy();
        res.writeHead(200, { "content-type": "audio/wav" });
        res.end(wav([5]));
      };

      const audio = await (await e.open("piper:uk:lada")).synthesize("Hi.");

      expect(audio.samples.length).toBe(2);
      expect(calls).toBe(3);
    });

    it("does not try again when the service answered with an error", async () => {
      const e = await ready();
      let calls = 0;
      handler = (_req, _body, res) => {
        calls++;
        json(res, 500, { code: "synthesis_failed", message: "Crashed." });
      };

      await expect((await e.open("piper:uk:lada")).synthesize("Hi.")).rejects.toThrow("Crashed.");
      expect(calls).toBe(1);
    });

    it("says the service is not reachable once the retries run out", async () => {
      const e = await ready();
      const session = await e.open("piper:uk:lada");
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));

      await expect(session.synthesize("Hi.")).rejects.toMatchObject({
        code: "unreachable",
        message: 'The speech service "piper" is not reachable.',
        detail: expect.stringContaining("ECONNREFUSED after 3 attempts"),
      });
      expect(e.reachable).toBe(false);
    });

    it("gives up after the request timeout", async () => {
      const e = await ready({ requestTimeoutMs: 50 });
      handler = () => {}; // never answers

      await expect((await e.open("piper:uk:lada")).synthesize("Hi.")).rejects.toMatchObject({
        code: "timeout",
      });
    });

    it("cancels the request when the caller aborts, or the session is closed", async () => {
      const e = await ready();
      handler = () => {};
      const session = await e.open("piper:uk:lada");
      const controller = new AbortController();

      const aborted = session.synthesize("Hi.", controller.signal);
      controller.abort();
      await expect(aborted).rejects.toMatchObject({ code: "aborted" });

      const closed = session.synthesize("Hi.");
      await session.close();
      await expect(closed).rejects.toMatchObject({ code: "aborted" });
    });
  });
});
