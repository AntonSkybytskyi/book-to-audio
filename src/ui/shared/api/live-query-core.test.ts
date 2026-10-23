import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { applyLiveEvent, applySnapshot, loadCurrent } from "./live-query-core";
import { gateFor } from "./query-client";
import type { Snapshot } from "./request";

const KEY = ["book", "b1"] as const;
const progress = (done: number) => ({ done });
type Progress = ReturnType<typeof progress>;
const bump = (done: number) => (current: Progress) =>
  done > current.done ? progress(done) : current;

describe("a slow answer and live events", () => {
  it("cannot undo progress an event already showed", async () => {
    const client = new QueryClient();
    client.setQueryData(KEY, progress(1));
    let release: (snapshot: Snapshot<Progress>) => void = () => {};
    const slow = new Promise<Snapshot<Progress>>((resolve) => (release = resolve));
    const load = vi
      .fn<() => Promise<Snapshot<Progress>>>()
      .mockReturnValueOnce(slow)
      .mockResolvedValue({ data: progress(12), seq: 12 });

    const loading = loadCurrent(client, KEY, load);
    expect(applyLiveEvent(client, KEY, bump(10), 10)).toBe("applied");
    expect(client.getQueryData(KEY)).toEqual(progress(10));
    release({ data: progress(5), seq: 5 });

    // The answer numbered 5 is older than the event numbered 10: it is dropped and asked for again.
    expect(await loading).toEqual(progress(12));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not apply an event that a load already includes", () => {
    const client = new QueryClient();
    applySnapshot(client, KEY, { data: progress(8), seq: 8 });
    const change = vi.fn<(current: Progress) => Progress>(bump(9));

    expect(applyLiveEvent(client, KEY, change, 8)).toBe("skipped");
    expect(applyLiveEvent(client, KEY, change, 7)).toBe("skipped");
    expect(change).not.toHaveBeenCalled();
    expect(client.getQueryData(KEY)).toEqual(progress(8));

    expect(applyLiveEvent(client, KEY, change, 9)).toBe("applied");
    expect(applyLiveEvent(client, KEY, change, 9)).toBe("skipped");
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("asks for a reload when an event cannot be applied", () => {
    const client = new QueryClient();
    client.setQueryData(KEY, progress(1));
    expect(applyLiveEvent(client, KEY, () => null, 3)).toBe("reload");
  });

  it("remembers an event that came before there was data, so the load can be repeated", () => {
    const client = new QueryClient();
    expect(applyLiveEvent(client, KEY, bump(5), 5)).toBe("skipped");
    expect(gateFor(client, KEY).takeCatchUp(3)).toBe(true);
  });

  it("keeps separate gates for separate queries", () => {
    const client = new QueryClient();
    applySnapshot(client, KEY, { data: progress(8), seq: 8 });
    expect(applyLiveEvent(client, ["book", "b2"], bump(1), 4)).toBe("skipped");
    client.setQueryData(["book", "b2"], progress(0));
    expect(applyLiveEvent(client, ["book", "b2"], bump(1), 4)).toBe("applied");
  });
});
