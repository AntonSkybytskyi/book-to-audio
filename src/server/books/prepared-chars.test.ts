import { describe, expect, it } from "vitest";
import { prepareChunks, prepareInThread, type TextPreparer } from "../convert/chapter-text.js";
import { TtsError } from "../tts/engine.js";
import { CountBudget, countPrepared, countPreparedDetailed } from "./prepared-chars.js";

const failing: TextPreparer = async (text) => {
  if (text.startsWith("bad")) throw new TtsError("bad_input", "took too long");
  return [text];
};

const cancelled: TextPreparer = async () => {
  throw new TtsError("aborted", "cancelled");
};

describe("countPrepared", () => {
  it("counts the characters of the chunks the engine would be given", async () => {
    const text = "In 1987 it cost $15.\n\nHe said it twice.";

    const [count] = await countPrepared([text], "en", 400, prepareInThread);

    expect(count).toBe(prepareChunks(text, "en", 400).join("").length);
    expect(count).not.toBe(text.length);
  });

  it("counts each text on its own, in order", async () => {
    const counts = await countPrepared(
      ["One.", "A longer sentence here."],
      "en",
      400,
      prepareInThread,
    );

    expect(counts[0]).toBeLessThan(counts[1] ?? 0);
    expect(counts).toHaveLength(2);
  });

  it("counts a text the rules gave up on at its raw length", async () => {
    expect(await countPrepared(["bad text", "good"], "en", 400, failing)).toEqual([8, 4]);
  });

  it("starts no more rules after one gave up, so a book that defeats them costs one time limit", async () => {
    let calls = 0;
    const counting: TextPreparer = async (text) => {
      calls++;
      return failing(text, "en", 400);
    };

    const counts = await countPrepared(["bad one", "fine two", "fine three"], "en", 400, counting);

    expect(counts).toEqual([7, 8, 10]); // the later texts by their raw length
    expect(calls).toBe(1);
  });

  it("stops using the rules once the time budget is spent", async () => {
    let now = 0;
    const budget = new CountBudget(70, () => now);
    const slow: TextPreparer = async (text) => {
      budget.start();
      now += 40;
      return [text];
    };

    const counts = await countPrepared(["aa", "bbb", "cccc", "ddddd"], "en", 400, slow, undefined, {
      budget,
    });

    expect(counts).toEqual([2, 3, 4, 5]);
    // Two texts were prepared (40 and 80 ms), and the third saw the budget gone.
    expect(now).toBe(80);
  });

  it("marks what it could not count as an approximation, and the rest as exact", async () => {
    expect(await countPreparedDetailed(["good", "bad text", "fine"], "en", 400, failing)).toEqual([
      { chars: 4, approx: false },
      { chars: 8, approx: true },
      { chars: 4, approx: true },
    ]);
  });

  it("does not run the clock while the first rule run has not started", () => {
    let now = 0;
    const budget = new CountBudget(100, () => now);

    now = 10_000; // waiting for its turn behind other books
    expect(budget.exceeded).toBe(false);
    budget.start();
    now += 50;
    expect(budget.exceeded).toBe(false);
    now += 60;
    expect(budget.exceeded).toBe(true);
    budget.start(); // a later start does not move it
    expect(budget.exceeded).toBe(true);
  });

  it("stops when cancelled, whether by the signal or by the caller", async () => {
    await expect(countPrepared(["a"], "en", 400, cancelled)).rejects.toMatchObject({
      code: "aborted",
    });
    await expect(
      countPrepared(["a"], "en", 400, prepareInThread, undefined, { shouldStop: () => true }),
    ).rejects.toMatchObject({ code: "aborted" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      countPrepared(["a"], "en", 400, prepareInThread, controller.signal),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("counts nothing for no texts", async () => {
    expect(await countPrepared([], "en", 400, prepareInThread)).toEqual([]);
  });
});
