import { describe, expect, it } from "vitest";
import { inspectApp, type GetJson } from "./cli-app.js";

const app =
  (bodies: Record<string, unknown>): GetJson =>
  async (url) => {
    const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+\/api/, "");
    if (!(path in bodies)) throw new Error(`no ${path}`);
    const body = bodies[path];
    if (body instanceof Error) throw body;
    return body;
  };

const quiet = {
  "/pool": { state: "running", activeWorkers: 0, held: false },
  "/benchmark": { state: "idle" },
  "/books": { books: [{ status: "done", outputs: { state: "ready" } }] },
  "/settings": { workers: 3 },
};

const refused: GetJson = async () => {
  throw new Error("ECONNREFUSED");
};

describe("inspectApp", () => {
  it("says it could not reach the app, which is not the same as idle", async () => {
    expect(await inspectApp(3000, app({}))).toEqual({ kind: "unreachable" });
    expect(await inspectApp(3000, refused)).toEqual({ kind: "unreachable" });
  });

  it("calls an app with nothing going on idle, and reads its worker count from the settings", async () => {
    expect(await inspectApp(3000, app(quiet))).toEqual({ kind: "idle", workers: 3 });
  });

  it.each([
    ["a chapter is being read", { "/pool": { state: "running", activeWorkers: 1, held: false } }],
    ["its own speed test", { "/pool": { state: "running", activeWorkers: 0, held: true } }],
    ["its own speed test", { "/benchmark": { state: "waiting" } }],
    [
      "queued for conversion",
      { "/books": { books: [{ status: "converting", outputs: { state: "none" } }] } },
    ],
    ["downloads", { "/books": { books: [{ status: "done", outputs: { state: "building" } }] } }],
  ])("is busy with %s", async (reason, change) => {
    const result = await inspectApp(3000, app({ ...quiet, ...change }));

    expect(result).toMatchObject({ kind: "busy", workers: 3 });
    expect(result.kind === "busy" && result.reason).toContain(reason);
  });

  it("does not call a book waiting behind a paused pool busy", async () => {
    const result = await inspectApp(
      3000,
      app({
        ...quiet,
        "/pool": { state: "paused", activeWorkers: 0, held: false },
        "/books": { books: [{ status: "converting" }] },
      }),
    );

    expect(result).toMatchObject({ kind: "idle" });
  });

  it("still answers when only some of the other endpoints do, with no worker count then", async () => {
    const result = await inspectApp(
      3000,
      app({ "/pool": quiet["/pool"], "/settings": new Error("500") }),
    );

    expect(result).toEqual({ kind: "idle", workers: null });
  });

  it("uses the port it was given", async () => {
    const urls: string[] = [];

    await inspectApp(3300, async (url) => {
      urls.push(url);
      return { state: "running" };
    });

    expect(urls[0]).toBe("http://127.0.0.1:3300/api/pool");
  });
});
