import { describe, expect, it } from "vitest";
import { Limiter } from "./limiter.js";

describe("Limiter", () => {
  it("runs at most the limit at once, and the rest in the order they came", async () => {
    const limiter = new Limiter(2);
    const started: number[] = [];
    const releases: (() => void)[] = [];
    const job = (n: number) =>
      limiter.run(
        () =>
          new Promise<number>((resolve) => {
            started.push(n);
            releases.push(() => resolve(n));
          }),
      );

    const results = [1, 2, 3, 4].map(job);
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    releases[0]?.();
    await results[0];
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]);
    releases[1]?.();
    releases[2]?.();
    await Promise.resolve();
    await Promise.resolve();
    releases[3]?.();

    expect(await Promise.all(results)).toEqual([1, 2, 3, 4]);
    expect(started).toEqual([1, 2, 3, 4]);
  });

  it("lets the next one go when a job fails", async () => {
    const limiter = new Limiter(1);

    const failing = limiter.run(async () => {
      throw new Error("no");
    });
    const next = limiter.run(async () => "ok");

    await expect(failing).rejects.toThrow("no");
    expect(await next).toBe("ok");
  });

  it("never runs more than the limit, even when jobs end and start in the same moment", async () => {
    const limiter = new Limiter(2);
    let running = 0;
    let most = 0;
    const job = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
      running--;
    };

    await Promise.all(Array.from({ length: 60 }, () => limiter.run(job)));

    expect(most).toBe(2);
  });

  it("hands the slot to the one that waited longest, not to a newcomer that arrives as a job ends", async () => {
    const limiter = new Limiter(1);
    const order: string[] = [];
    let endFirst!: () => void;
    const first = limiter.run(
      () =>
        new Promise<void>((resolve) => {
          endFirst = resolve;
        }),
    );
    const second = limiter.run(async () => void order.push("second"));

    endFirst();
    // The first job's slot is passed on in the same turn; a job asked for right now queues behind it.
    const third = limiter.run(async () => void order.push("third"));
    await Promise.all([first, second, third]);

    expect(order).toEqual(["second", "third"]);
  });
});
