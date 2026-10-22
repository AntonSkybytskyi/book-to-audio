import { describe, expect, it } from "vitest";
import { runProcess } from "./process.js";

async function* hello() {
  yield Buffer.from("hel");
  yield Buffer.from("lo");
}

async function* manyKilobytes() {
  for (let i = 0; i < 64; i++) yield Buffer.alloc(64 * 1024);
}

async function* broken() {
  yield Buffer.from("partial");
  throw Object.assign(new Error("disk went away"), { code: "ENOENT" });
}

const node = (code: string) => [process.execPath, ["-e", code]] as const;

describe("runProcess", () => {
  it("collects stdout, stderr and the exit code", async () => {
    const [cmd, args] = node(
      `process.stdout.write("out"); process.stderr.write("err"); process.exit(3)`,
    );

    const result = await runProcess(cmd, args, { timeoutMs: 5000 });

    expect(result).toMatchObject({ code: 3, stderr: "err", timedOut: false, aborted: false });
    expect(result.stdout.toString()).toBe("out");
  });

  it("hands stdout to onStdout as it arrives and does not collect it", async () => {
    const [cmd, args] = node(
      `process.stdout.write("one"); setTimeout(() => process.stdout.write("two"), 30)`,
    );
    const seen: string[] = [];

    const result = await runProcess(cmd, args, {
      timeoutMs: 5000,
      onStdout: (chunk) => seen.push(chunk.toString()),
    });

    expect(seen.join("")).toBe("onetwo");
    expect(result.stdout.length).toBe(0);
  });

  it("writes input to stdin", async () => {
    const [cmd, args] = node(`process.stdin.pipe(process.stdout)`);

    const result = await runProcess(cmd, args, { input: "hello", timeoutMs: 5000 });

    expect(result.stdout.toString()).toBe("hello");
  });

  it("streams an async iterable to stdin", async () => {
    const [cmd, args] = node(`process.stdin.pipe(process.stdout)`);
    const result = await runProcess(cmd, args, { input: hello(), timeoutMs: 5000 });

    expect(result.stdout.toString()).toBe("hello");
  });

  it("streams more than the pipe buffer holds, waiting for the process to read it", async () => {
    const [cmd, args] = node(
      `let n = 0; process.stdin.on("data", (d) => (n += d.length)); process.stdin.on("end", () => process.stdout.write(String(n)))`,
    );
    const result = await runProcess(cmd, args, { input: manyKilobytes(), timeoutMs: 10_000 });

    expect(result.stdout.toString()).toBe(String(64 * 64 * 1024));
  });

  it("fails when the input stream breaks, instead of passing on what came before", async () => {
    const [cmd, args] = node(`process.stdin.pipe(process.stdout)`);
    const error = await runProcess(cmd, args, { input: broken(), timeoutMs: 5000 }).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ message: expect.stringContaining("disk went away") });
    expect((error as NodeJS.ErrnoException).code).toBeUndefined(); // not mistaken for a missing binary
  });

  it("stops reading the input when the process exits early", async () => {
    const [cmd, args] = node(`process.exit(0)`);
    let produced = 0;
    async function* endless() {
      for (;;) {
        produced++;
        yield Buffer.alloc(64 * 1024);
      }
    }

    const result = await runProcess(cmd, args, { input: endless(), timeoutMs: 5000 });

    expect(result.code).toBe(0);
    expect(produced).toBeLessThan(1000);
  });

  it("passes arguments without a shell", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", "$(echo injected); `id`"],
      { timeoutMs: 5000 },
    );

    expect(result.stdout.toString()).toBe("$(echo injected); `id`");
  });

  it("kills a process that runs too long", async () => {
    const [cmd, args] = node(`setTimeout(() => {}, 60000)`);

    const result = await runProcess(cmd, args, { timeoutMs: 100 });

    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });

  it("kills a process when the signal aborts", async () => {
    const [cmd, args] = node(`setTimeout(() => {}, 60000)`);
    const controller = new AbortController();

    const pending = runProcess(cmd, args, { timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    expect((await pending).aborted).toBe(true);
  });

  it("does not start when the signal is already aborted", async () => {
    // A command that cannot be spawned would reject if it were started.
    const result = await runProcess("/no/such/binary", [], {
      timeoutMs: 60_000,
      signal: AbortSignal.abort(),
    });

    expect(result).toMatchObject({ aborted: true, code: null });
  });

  it("rejects when the command does not exist", async () => {
    await expect(runProcess("/no/such/binary", [], { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects when stdout grows past the limit", async () => {
    const [cmd, args] = node(`process.stdout.write(Buffer.alloc(100000))`);

    await expect(runProcess(cmd, args, { timeoutMs: 5000, maxStdoutBytes: 1000 })).rejects.toThrow(
      /more than 1000 bytes/,
    );
  });

  it("survives a process that exits without reading its input", async () => {
    const [cmd, args] = node(`process.exit(0)`);

    const result = await runProcess(cmd, args, { input: Buffer.alloc(5_000_000), timeoutMs: 5000 });

    expect(result.code).toBe(0);
  });
});
