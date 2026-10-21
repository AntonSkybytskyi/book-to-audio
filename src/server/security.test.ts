import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostname, registerHostAndOriginGuard } from "./security.js";

describe("hostname", () => {
  it.each([
    ["localhost:3000", "localhost"],
    ["LOCALHOST", "localhost"],
    ["127.0.0.1:3300", "127.0.0.1"],
    ["[::1]:3000", "[::1]"],
    ["[::1]", "[::1]"],
    ["evil.example:80", "evil.example"],
  ])("reads %s as %s", (host, expected) => {
    expect(hostname(host)).toBe(expected);
  });
});

describe("registerHostAndOriginGuard", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    registerHostAndOriginGuard(app, ["books.lan"]);
    app.all("/*", async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(() => app.close());

  const request = (method: "GET" | "POST" | "PATCH", headers: Record<string, string | undefined>) =>
    app.inject({ method, url: "/x", headers: headers as Record<string, string> });

  it.each(["localhost:3000", "127.0.0.1:3300", "[::1]:3000", "localhost", "books.lan:3000"])(
    "allows Host %s",
    async (host) => {
      expect((await request("GET", { host })).statusCode).toBe(200);
    },
  );

  it.each(["evil.example", "evil.example:3000", "localhost.evil.example", "10.0.0.5:3000"])(
    "rejects Host %j with 403",
    async (host) => {
      const res = await request("GET", { host });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "forbidden" });
    },
  );

  it("allows a POST from the same origin", async () => {
    const res = await request("POST", {
      host: "localhost:3300",
      origin: "http://localhost:3300",
      "sec-fetch-site": "same-origin",
    });

    expect(res.statusCode).toBe(200);
  });

  it("allows a POST with no Origin, such as curl", async () => {
    expect((await request("POST", { host: "localhost:3000" })).statusCode).toBe(200);
  });

  it.each([
    { origin: "http://evil.example" },
    { origin: "http://localhost:4000" },
    { origin: "null" },
    { origin: "not a url" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ])("rejects a POST with %j", async (extra) => {
    const res = await request("POST", { host: "localhost:3000", ...extra });

    expect(res.statusCode).toBe(403);
  });

  it("rejects a cross-site PATCH", async () => {
    const res = await request("PATCH", { host: "localhost:3000", origin: "https://evil.example" });

    expect(res.statusCode).toBe(403);
  });

  it("does not check Origin on reads", async () => {
    const res = await request("GET", { host: "localhost:3000", origin: "http://evil.example" });

    expect(res.statusCode).toBe(200);
  });
});
