import { describe, expect, it, vi } from "vitest";
import { loadUntilCurrent, OVERTAKEN_DELAYS_MS, SeqGate } from "./seq-gate";

describe("SeqGate", () => {
  it("accepts a first load and the events after it", () => {
    const gate = new SeqGate();

    expect(gate.acceptSnapshot(100)).toBe(true);
    expect(gate.acceptEvent(101)).toBe(true);
    expect(gate.acceptEvent(102)).toBe(true);
  });

  it("skips events that the load already includes, and events seen twice", () => {
    const gate = new SeqGate();
    gate.acceptSnapshot(100);

    expect(gate.acceptEvent(99)).toBe(false);
    expect(gate.acceptEvent(100)).toBe(false);
    expect(gate.acceptEvent(101)).toBe(true);
    expect(gate.acceptEvent(101)).toBe(false);
    expect(gate.acceptEvent(100.5)).toBe(false);
  });

  it("drops a load that an event overtook while it was on its way", () => {
    const gate = new SeqGate();
    gate.acceptSnapshot(100);
    // A load is requested at 100; before it answers, events 101 and 102 arrive.
    gate.acceptEvent(101);
    gate.acceptEvent(102);

    expect(gate.acceptSnapshot(100)).toBe(false);
    expect(gate.acceptSnapshot(101)).toBe(false);
    // The repeated load was requested after those events, so it includes them.
    expect(gate.acceptSnapshot(102)).toBe(true);
  });

  it("takes events newer than a load that was accepted late, but not the ones in it", () => {
    const gate = new SeqGate();
    gate.acceptEvent(5); // nothing loaded yet; an event came first

    expect(gate.acceptSnapshot(7)).toBe(true);
    expect(gate.acceptEvent(6)).toBe(false);
    expect(gate.acceptEvent(8)).toBe(true);
  });

  it("reports the sequence number of the newest load for the reconnect check", () => {
    const gate = new SeqGate();
    gate.acceptSnapshot(40);
    gate.acceptEvent(45);

    expect(gate.snapshotSeq).toBe(40);
  });

  it("keeps working when a restarted server numbers its events higher", () => {
    const gate = new SeqGate();
    gate.acceptSnapshot(1_800_000_000_000_000);
    gate.acceptEvent(1_800_000_000_000_010);

    expect(gate.acceptEvent(1_800_000_060_000_001)).toBe(true);
  });
});

describe("SeqGate with unknown numbers and restarts", () => {
  it("always takes an answer that has no number, without changing what it knows", () => {
    const gate = new SeqGate();
    gate.acceptSnapshot(100);
    gate.acceptEvent(110);

    expect(gate.acceptSnapshot(0)).toBe(true);
    expect(gate.highest).toBe(110);
  });

  it("can be forced to take an answer that events overtook", () => {
    const gate = new SeqGate();
    gate.acceptEvent(200);

    expect(gate.acceptSnapshot(150)).toBe(false);
    expect(gate.acceptSnapshot(150, true)).toBe(true);
    expect(gate.snapshotSeq).toBe(150);
  });

  it("starts over for a server whose numbers are lower than the old one's", () => {
    const gate = new SeqGate();
    gate.acceptSnapshot(1_000);
    gate.acceptEvent(1_050);
    // The server restarted with its clock behind: everything it says is "older".
    expect(gate.acceptSnapshot(5)).toBe(false);

    gate.sync(1, 5);

    expect(gate.highest).toBe(0);
    expect(gate.acceptSnapshot(5)).toBe(true);
    expect(gate.acceptEvent(6)).toBe(true);
  });

  it("keeps what it knows when a new connection continues from the same numbers", () => {
    const gate = new SeqGate();
    gate.acceptSnapshot(1_000);
    gate.sync(1, 1_000); // first connection
    gate.acceptEvent(1_020);

    gate.sync(2, 1_030); // reconnected to the same server, which has moved on

    expect(gate.highest).toBe(1_020);
    expect(gate.acceptEvent(1_020)).toBe(false);
  });

  it("looks at a connection only once", () => {
    const gate = new SeqGate();
    gate.sync(1, 50);
    gate.acceptEvent(60);

    gate.sync(1, 50); // the same connection, asked again

    expect(gate.highest).toBe(60);
  });

  it("asks for a catch-up when events came before the first load, once", () => {
    const gate = new SeqGate();
    gate.noteEarlyEvent(120);
    gate.noteEarlyEvent(110);

    expect(gate.takeCatchUp(115)).toBe(true);
    expect(gate.takeCatchUp(115)).toBe(false);
  });

  it("needs no catch-up when the first load already includes the early events or has no number", () => {
    const gate = new SeqGate();
    gate.noteEarlyEvent(100);
    expect(gate.takeCatchUp(100)).toBe(false);

    gate.noteEarlyEvent(100);
    expect(gate.takeCatchUp(0)).toBe(false);
  });
});

describe("loadUntilCurrent", () => {
  const instant = async () => {};

  it("returns the first answer when nothing overtook it", async () => {
    const gate = new SeqGate();
    const load = vi.fn<() => Promise<{ data: string; seq: number }>>(async () => ({
      data: "a",
      seq: 10,
    }));

    expect(await loadUntilCurrent(load, gate, instant)).toEqual({ data: "a", seq: 10 });
    expect(load).toHaveBeenCalledOnce();
  });

  it("asks again, after short waits, while events keep overtaking the answer, then takes it", async () => {
    const gate = new SeqGate();
    gate.acceptEvent(500);
    const waits: number[] = [];
    const load = vi.fn<() => Promise<{ data: string; seq: number }>>(async () => ({
      data: "old",
      seq: 400,
    }));

    const answer = await loadUntilCurrent(load, gate, async (ms) => void waits.push(ms));

    expect(answer.data).toBe("old");
    expect(load).toHaveBeenCalledTimes(OVERTAKEN_DELAYS_MS.length + 1);
    expect(waits).toEqual([...OVERTAKEN_DELAYS_MS]);
  });

  it("stops asking as soon as an answer is current", async () => {
    const gate = new SeqGate();
    gate.acceptEvent(500);
    let calls = 0;
    const load = async () => ({ data: `n${++calls}`, seq: calls === 1 ? 400 : 505 });

    const answer = await loadUntilCurrent(load, gate, instant);

    expect(answer).toEqual({ data: "n2", seq: 505 });
  });

  it("converges under a high event rate for other books: at most one more try than waits", async () => {
    const gate = new SeqGate();
    gate.acceptEvent(1_000);
    let now = 1_000;
    // Every answer is numbered when it is asked for, but ten events arrive for other books before it comes back.
    const load = async () => {
      const seq = now;
      for (let i = 0; i < 10; i++) gate.acceptEvent(++now);
      return { data: seq, seq };
    };
    const waits: number[] = [];

    const answer = await loadUntilCurrent(load, gate, async (ms) => void waits.push(ms));

    expect(waits).toHaveLength(OVERTAKEN_DELAYS_MS.length);
    expect(answer.seq).toBeLessThan(gate.highest); // taken a moment behind, and the next event fixes it
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(500);
  });

  it("does not loop for answers without a number", async () => {
    const gate = new SeqGate();
    gate.acceptEvent(900);
    const load = vi.fn<() => Promise<{ data: string; seq: number }>>(async () => ({
      data: "x",
      seq: 0,
    }));

    await loadUntilCurrent(load, gate, instant);

    expect(load).toHaveBeenCalledOnce();
  });
});
