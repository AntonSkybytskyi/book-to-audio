import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppEvent } from "../events/bus.js";
import { settled, useOutputsHarness } from "../testing/outputs-harness.js";
import { tick } from "../testing/pool-harness.js";
import { OutputError } from "./errors.js";
import { toOutputsView } from "./view.js";
import { syncDirectory } from "./builder.js";

const outputsEvents = (events: AppEvent[], bookId: string) =>
  events.flatMap((event) => (event.type === "outputs" && event.bookId === bookId ? [event] : []));

const failingOpen = (code: string) =>
  (async () => ({
    sync: async () => {
      throw Object.assign(new Error(code), { code });
    },
    close: async () => {},
  })) as unknown as typeof import("node:fs/promises").open;

describe("OutputBuilder", () => {
  const h = useOutputsHarness();

  it("builds the downloads of a book that becomes done, and records the generation it built from", async () => {
    const id = h.addDoneBook(2);
    h.builder.start();
    // start() queued it already (a done book without outputs); let it run.
    await settled(() => h.producer.isRunning(id));
    expect(h.state(id)).toBe("building");

    h.producer.release(id);
    await settled(() => h.state(id) === "ready");

    const row = h.outputs.get(id);
    expect(row).toMatchObject({ builtGeneration: h.generation(id), progress: 1, error: null });
    expect(fs.readFileSync(h.ctx.storage.outputFile(id, "m4b"), "utf8")).toBe("m4b #1");
    expect(fs.readFileSync(h.ctx.storage.outputFile(id, "zip"), "utf8")).toBe("zip #1");
    expect(row?.m4bBytes).toBe(6);
    expect(row?.zipBytes).toBe(6);
    // The work folder is removed right after the result is recorded; only the two files remain.
    await settled(() => h.files(id).length === 2);
    expect(h.files(id)).toEqual(["book.m4b", "book.zip"]);
  });

  it("says when no build is left, so something that waited for a quiet machine can go", async () => {
    let idle = 0;
    const builder = h.restart({ onIdle: () => idle++ });
    const first = h.addDoneBook();
    const second = h.addDoneBook();
    builder.start();
    await settled(() => h.producer.isRunning(first));
    expect(builder.anyBusy).toBe(true);

    h.producer.release(first);
    await settled(() => h.producer.isRunning(second));
    expect(idle).toBe(0); // one more is waiting its turn
    h.producer.release(second);
    await settled(() => idle === 1);

    expect(builder.anyBusy).toBe(false);
    await builder.stop();
  });

  it("does not start a build while the pool is held for the speed test, and starts it when it is over", async () => {
    let held = true;
    const builder = h.restart({ hold: () => held });
    const id = h.addDoneBook();
    builder.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.producer.started).toEqual([]);
    expect(builder.anyBusy).toBe(true); // queued

    held = false;
    h.ctx.bus.publish({
      type: "pool",
      state: "running",
      error: null,
      cause: null,
      workers: 1,
      activeWorkers: 0,
      held: false,
      services: [],
    });
    await settled(() => h.producer.isRunning(id));

    h.producer.release(id);
    await settled(() => h.state(id) === "ready");
    await builder.stop();
  });

  it("starts a build when the pool announces that a book is done", async () => {
    h.builder.start();
    h.producer.hold = false;
    const id = h.addDoneBook();

    h.announceDone(id);
    await settled(() => h.state(id) === "ready");

    expect(h.producer.started).toEqual([id]);
  });

  it("publishes queued, building with progress, and ready, in that order and never out of order", async () => {
    h.builder.start();
    const id = h.addDoneBook();
    h.announceDone(id);
    await settled(() => h.producer.isRunning(id));
    h.producer.release(id);
    await settled(() => h.state(id) === "ready");

    const states = outputsEvents(h.events, id).map((event) => event.state);
    expect(states[0]).toBe("queued");
    expect(states).toContain("building");
    expect(states.at(-1)).toBe("ready");
    expect(
      outputsEvents(h.events, id).some((e) => e.state === "building" && e.progress === 0.25),
    ).toBe(true);
    expect(outputsEvents(h.events, id).at(-1)).toMatchObject({ available: true, m4bBytes: 6 });
    // The book event came first: the outputs event was published after it, not from inside it.
    const bookAt = h.events.findIndex((e) => e.type === "book");
    const queuedAt = h.events.findIndex((e) => e.type === "outputs");
    expect(bookAt).toBeLessThan(queuedAt);
  });

  it("does not repeat an event when nothing changed", async () => {
    h.builder.start();
    h.producer.hold = false;
    const id = h.addDoneBook();
    h.announceDone(id);
    await settled(() => h.state(id) === "ready");
    const before = outputsEvents(h.events, id).length;

    h.announceDone(id);
    h.announceDone(id);
    await tick();
    await tick();

    expect(outputsEvents(h.events, id)).toHaveLength(before);
    expect(h.producer.started).toHaveLength(1);
  });

  it("never builds for a book that is not done, nor for done_with_errors", async () => {
    h.builder.start();
    h.producer.hold = false;
    const converting = h.addDoneBook();
    h.ctx.db.prepare("UPDATE books SET status = 'converting' WHERE id = ?").run(converting);
    const errors = h.addDoneBook();
    h.ctx.db.prepare("UPDATE books SET status = 'done_with_errors' WHERE id = ?").run(errors);

    h.announceDone(converting);
    h.announceDone(errors);
    await tick();
    await tick();

    expect(h.builder.request(converting)).toBe(false);
    expect(h.builder.request(errors, { force: true })).toBe(false);
    expect(h.producer.started).toEqual([]);
    expect(h.outputs.get(converting)).toBeUndefined();
    expect(h.outputs.get(errors)).toBeUndefined();
  });

  it("builds one book at a time, in the order they were asked for", async () => {
    h.builder.start();
    const [a, b, c] = [h.addDoneBook(), h.addDoneBook(), h.addDoneBook()] as [
      string,
      string,
      string,
    ];
    h.builder.request(a);
    h.builder.request(b);
    h.builder.request(c);

    await settled(() => h.producer.isRunning(a));
    await tick();
    expect(h.producer.started).toEqual([a]);
    expect([h.state(b), h.state(c)]).toEqual(["queued", "queued"]);

    h.producer.release(a);
    await settled(() => h.producer.isRunning(b));
    expect(h.producer.started).toEqual([a, b]);
    h.producer.release(b);
    await settled(() => h.producer.isRunning(c));
    h.producer.release(c);
    await settled(() => h.state(c) === "ready");
    expect(h.producer.started).toEqual([a, b, c]);
  });

  describe("generation compare", () => {
    it("does not record files when a chapter's audio was written during the build, and builds again", async () => {
      h.builder.start();
      const id = h.addDoneBook(2);
      h.builder.request(id);
      await settled(() => h.producer.isRunning(id));
      const first = h.generation(id);

      h.rewriteChapter(id, 1);
      h.producer.release(id);
      // The first result is thrown away and a second build starts from the new generation.
      await settled(() => h.producer.started.length === 2);

      expect(h.outputs.get(id)?.builtGeneration).toBeNull();
      expect(outputsEvents(h.events, id).some((e) => e.available)).toBe(false);
      h.producer.release(id);
      await settled(() => h.state(id) === "ready");
      expect(h.outputs.get(id)?.builtGeneration).toBe(first + 1);
    });

    it("offers a download only while the recorded generation equals the book's", async () => {
      h.builder.start();
      h.producer.hold = false;
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.state(id) === "ready");
      expect(h.repo.get(id)?.outputs?.builtGeneration).toBe(h.generation(id));

      h.rewriteChapter(id, 2);

      const book = h.repo.get(id);
      expect(book?.audioGeneration).not.toBe(book?.outputs?.builtGeneration);
    });

    it("drops the result when the book stopped being done during the build, and offers nothing", async () => {
      h.builder.start();
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.producer.isRunning(id));

      h.ctx.db.prepare("UPDATE books SET status = 'converting' WHERE id = ?").run(id);
      h.producer.release(id);
      await settled(() => !h.producer.isRunning(id) && h.outputs.get(id) === undefined);

      expect(h.files(id)).toEqual(["book.m4b", "book.zip"]); // renamed, but never recorded as current
      expect(h.repo.get(id)?.outputs).toBeNull();
      expect(h.producer.started).toEqual([id]);
    });

    it("rebuilds a stale ready book when it becomes done again", async () => {
      h.builder.start();
      h.producer.hold = false;
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.state(id) === "ready");

      // Regenerate one chapter: the book leaves done, the chapter is written, the book is done again.
      h.ctx.db.prepare("UPDATE books SET status = 'converting' WHERE id = ?").run(id);
      h.announceDone(id);
      await tick();
      expect(outputsEvents(h.events, id).at(-1)).toMatchObject({
        available: false,
        updating: true,
      });
      h.rewriteChapter(id, 1);
      h.ctx.db.prepare("UPDATE books SET status = 'done' WHERE id = ?").run(id);
      h.announceDone(id);
      await settled(() => h.producer.started.length === 2 && h.state(id) === "ready");

      expect(h.outputs.get(id)?.builtGeneration).toBe(h.generation(id));
      expect(fs.readFileSync(h.ctx.storage.outputFile(id, "m4b"), "utf8")).toBe("m4b #2");
    });
  });

  describe("failure", () => {
    it("records the message, keeps the state failed, and does not retry by itself", async () => {
      h.builder.start();
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.producer.isRunning(id));

      h.producer.failWith(id, new OutputError("Chapter 2 has no audio."));
      await settled(() => h.state(id) === "failed");

      expect(h.outputs.get(id)?.error).toBe("Chapter 2 has no audio.");
      expect(outputsEvents(h.events, id).at(-1)).toMatchObject({
        state: "failed",
        error: "Chapter 2 has no audio.",
        available: false,
      });
      h.announceDone(id);
      await tick();
      await tick();
      expect(h.producer.started).toHaveLength(1);
      expect(h.logged.some((l) => l.level === "error")).toBe(true);
    });

    it("shows a plain message for an error that is not meant for the owner", async () => {
      h.builder.start();
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.producer.isRunning(id));

      h.producer.failWith(id, new Error("EACCES: /secret/path"));
      await settled(() => h.state(id) === "failed");

      expect(h.outputs.get(id)?.error).toBe("Something went wrong while building the downloads.");
    });

    it("turns a full disk into its own message", async () => {
      h.builder.start();
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.producer.isRunning(id));

      h.producer.failWith(id, Object.assign(new Error("write"), { code: "ENOSPC" }));
      await settled(() => h.state(id) === "failed");

      expect(h.outputs.get(id)?.error).toMatch(/not enough free disk space/);
    });

    it("leaves nothing behind but the files of an earlier successful build", async () => {
      h.builder.start();
      h.producer.hold = false;
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.state(id) === "ready");
      h.producer.hold = true;

      await settled(() => !h.builder.isBusy(id));
      h.builder.request(id, { force: true });
      await settled(() => h.producer.isRunning(id));
      h.producer.failWith(id, new OutputError("boom"));
      await settled(() => h.state(id) === "failed");

      // The work folder goes right after the failure is recorded.
      await settled(() => h.files(id).length === 2);
      expect(h.files(id)).toEqual(["book.m4b", "book.zip"]);
    });

    it("retries when asked, and by itself once the audio has changed", async () => {
      h.builder.start();
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.producer.isRunning(id));
      h.producer.failWith(id, new OutputError("boom"));
      await settled(() => h.state(id) === "failed");

      expect(h.builder.request(id)).toBe(false);
      await settled(() => !h.builder.isBusy(id));
      expect(h.builder.request(id, { force: true })).toBe(true);
      await settled(() => h.producer.isRunning(id));
      h.producer.failWith(id, new OutputError("boom again"));
      await settled(() => h.outputs.get(id)?.error === "boom again");

      h.rewriteChapter(id, 1);
      h.announceDone(id);
      await settled(() => h.producer.isRunning(id));
      h.producer.release(id);
      await settled(() => h.state(id) === "ready");
    });
  });

  describe("cancel", () => {
    it("aborts a running build, waits for it, removes its files and withdraws the request", async () => {
      h.builder.start();
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.producer.isRunning(id));
      const job = h.producer.jobs[0];

      await h.builder.cancel(id);

      expect(job?.signal.aborted).toBe(true);
      expect(h.producer.isRunning(id)).toBe(false);
      expect(h.outputs.get(id)).toBeUndefined();
      expect(h.files(id)).toEqual([]);
      expect(fs.existsSync(job?.workDir ?? "")).toBe(false);
    });

    it("puts a book that had files back to ready (stale), not to failed", async () => {
      h.builder.start();
      h.producer.hold = false;
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.state(id) === "ready");
      h.producer.hold = true;
      h.rewriteChapter(id, 1);
      h.announceDone(id);
      await settled(() => h.producer.isRunning(id));

      await h.builder.cancel(id);

      const row = h.outputs.get(id);
      expect(row?.state).toBe("ready");
      expect(row?.builtGeneration).toBe(h.generation(id) - 1);
      expect(h.repo.get(id)?.outputs?.state).toBe("ready");
      expect(outputsEvents(h.events, id).at(-1)).toMatchObject({
        available: false,
        updating: true,
      });
    });

    it("drops a request that has not started", async () => {
      h.builder.start();
      const [a, b] = [h.addDoneBook(), h.addDoneBook()] as [string, string];
      h.builder.request(a);
      h.builder.request(b);
      await settled(() => h.producer.isRunning(a));
      expect(h.state(b)).toBe("queued");

      await h.builder.cancel(b);
      h.producer.release(a);
      await settled(() => h.state(a) === "ready");

      expect(h.producer.started).toEqual([a]);
      expect(h.outputs.get(b)).toBeUndefined();
    });

    it("does nothing for a book with no build", async () => {
      await expect(h.builder.cancel("nobody")).resolves.toBeUndefined();
    });

    it("lets a deleted book's files be removed afterwards without the build recreating them", async () => {
      h.builder.start();
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.producer.isRunning(id));

      h.ctx.db.prepare("DELETE FROM books WHERE id = ?").run(id);
      await h.builder.cancel(id);
      h.ctx.storage.removeBookFiles(id);
      await tick();

      expect(fs.existsSync(h.ctx.storage.outputsDir(id))).toBe(false);
      expect(h.builder.request(id)).toBe(false);
      expect(h.outputs.get(id)).toBeUndefined();
    });
  });

  describe("restart", () => {
    it("picks up a build that was interrupted and starts one for a done book that has none", async () => {
      const interrupted = h.addDoneBook();
      h.outputs.enqueue(interrupted);
      h.outputs.begin(interrupted, h.generation(interrupted));
      const converted = h.addDoneBook(); // done before this slice existed: no row
      h.producer.hold = false;

      h.restart().start();
      await settled(() => h.state(interrupted) === "ready" && h.state(converted) === "ready");

      expect(h.producer.started).toEqual([interrupted, converted]);
    });

    it("leaves current files alone and retries a failed build", async () => {
      h.producer.hold = false;
      const current = h.addDoneBook();
      const failed = h.addDoneBook();
      h.builder.start();
      await settled(() => h.state(current) === "ready" && h.state(failed) === "ready");
      h.ctx.db
        .prepare("UPDATE book_outputs SET state = 'failed', error = 'x' WHERE book_id = ?")
        .run(failed);
      await h.builder.stop();
      h.producer.started.length = 0;

      h.restart().start();
      await settled(() => h.state(failed) === "ready");

      expect(h.producer.started).toEqual([failed]);
    });

    it("keeps a build that was stopped by shutdown as building, for the next start", async () => {
      h.builder.start();
      const id = h.addDoneBook();
      h.builder.request(id);
      await settled(() => h.producer.isRunning(id));

      await h.builder.stop();

      expect(h.state(id)).toBe("building");
      expect(h.files(id)).toEqual([]);
      h.producer.hold = false;
      h.restart().start();
      await settled(() => h.state(id) === "ready");
    });

    it("skips an interrupted request whose book is gone", async () => {
      const id = h.addDoneBook();
      h.outputs.enqueue(id);
      h.ctx.db.pragma("foreign_keys = OFF");
      h.ctx.db.prepare("DELETE FROM books WHERE id = ?").run(id);
      h.ctx.db.pragma("foreign_keys = ON");

      h.restart().start();
      await tick();

      expect(h.producer.started).toEqual([]);
    });
  });

  it("looks again at a request that arrived while the build was still running", async () => {
    h.builder.start();
    const id = h.addDoneBook();
    h.builder.request(id);
    await settled(() => h.producer.isRunning(id));

    expect(h.builder.request(id, { force: true })).toBe(false);
    h.producer.hold = false;
    h.producer.release(id);
    await settled(() => h.producer.started.length === 2 && h.state(id) === "ready");
    await settled(() => !h.builder.isBusy(id));

    expect(h.producer.started).toHaveLength(2);
  });

  it("saves progress while building and shows it in the book", async () => {
    h.builder.start();
    const id = h.addDoneBook();
    h.builder.request(id);
    await settled(() => h.producer.isRunning(id));

    expect(h.outputs.get(id)?.progress).toBe(0.25);
    expect(h.repo.get(id)?.outputs?.progress).toBe(0.25);
  });

  const built = async () => {
    h.builder.start();
    h.producer.hold = false;
    const id = h.addDoneBook();
    h.builder.request(id);
    await settled(() => h.state(id) === "ready");
    await settled(() => !h.builder.isBusy(id));
    h.producer.hold = true;
    return id;
  };
  const view = (id: string) => {
    const book = h.repo.get(id);
    return toOutputsView(book?.status ?? "done", book?.audioGeneration ?? 0, book?.outputs);
  };
  /** A builder whose book lookups fail for one book once `breakIt()` is called. */
  const withBrokenLookups = (target: () => string | null) => {
    const books = {
      get: (id: string) => {
        if (id === target()) throw new Error("database is locked");
        return h.repo.get(id);
      },
      chapters: (id: string) => h.repo.chapters(id),
    };
    return h.restart({ books });
  };

  describe("a rebuild of audio that is already on offer", () => {
    it("keeps the files on offer while a forced rebuild runs, and replaces them when it is done", async () => {
      const id = await built();

      h.builder.request(id, { force: true });
      await settled(() => h.producer.isRunning(id));

      expect(h.state(id)).toBe("building");
      expect(view(id)).toMatchObject({
        state: "building",
        available: true,
        updating: false,
        m4bBytes: 6,
      });
      expect(outputsEvents(h.events, id).at(-1)).toMatchObject({
        state: "building",
        available: true,
      });
      expect(fs.readFileSync(h.ctx.storage.outputFile(id, "m4b"), "utf8")).toBe("m4b #1");

      h.producer.release(id);
      await settled(() => h.state(id) === "ready");
      expect(fs.readFileSync(h.ctx.storage.outputFile(id, "m4b"), "utf8")).toBe("m4b #2");
      expect(view(id)).toMatchObject({ state: "ready", available: true });
    });

    it("keeps the old files on offer, and says so, when the rebuild fails", async () => {
      const id = await built();

      h.builder.request(id, { force: true });
      await settled(() => h.producer.isRunning(id));
      h.producer.failWith(id, new OutputError("Chapter 2 is incomplete."));
      await settled(() => h.state(id) === "failed");

      expect(view(id)).toMatchObject({
        state: "failed",
        available: true,
        error: "Chapter 2 is incomplete.",
        m4bBytes: 6,
      });
      expect(fs.readFileSync(h.ctx.storage.outputFile(id, "m4b"), "utf8")).toBe("m4b #1");
      await settled(() => h.files(id).length === 2);
      expect(h.files(id)).toEqual(["book.m4b", "book.zip"]);
    });

    it("withdraws them only once the audio moved on", async () => {
      const id = await built();

      h.builder.request(id, { force: true });
      await settled(() => h.producer.isRunning(id));
      h.rewriteChapter(id, 1);

      expect(view(id)).toMatchObject({ state: "building", available: false, updating: true });
    });
  });

  it("gives both files the same private mode", async () => {
    h.builder.start();
    h.producer.hold = false;
    const id = h.addDoneBook();
    h.builder.request(id);
    await settled(() => h.state(id) === "ready");

    for (const kind of ["m4b", "zip"] as const) {
      expect(fs.statSync(h.ctx.storage.outputFile(id, kind)).mode & 0o777).toBe(0o600);
    }
  });

  describe("when the database fails after a build", () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    beforeEach(() => {
      unhandled.length = 0;
      process.on("unhandledRejection", record);
    });
    afterEach(() => {
      process.off("unhandledRejection", record);
    });

    it("does not crash, still starts the next build, and lets cancel and stop finish", async () => {
      let broken: string | null = null;
      const builder = withBrokenLookups(() => broken);
      builder.start();
      const [a, b] = [h.addDoneBook(), h.addDoneBook()] as [string, string];
      builder.request(a);
      builder.request(b);
      await settled(() => h.producer.isRunning(a));
      // A request that comes while A runs is looked at again afterwards, and that lookup throws.
      builder.request(a);
      broken = a;

      h.producer.release(a);
      await settled(() => h.producer.isRunning(b));

      expect(builder.isBusy(a)).toBe(false);
      await expect(builder.cancel(a)).resolves.toBeUndefined();
      h.producer.release(b);
      await settled(() => h.state(b) === "ready");
      await expect(builder.stop()).resolves.toBeUndefined();
      await tick();
      expect(unhandled).toEqual([]);
      expect(h.logged.some((l) => l.level === "error")).toBe(true);
    });

    it("never rejects job.done, so a delete that waits for the build is not taken down", async () => {
      let broken: string | null = null;
      const builder = withBrokenLookups(() => broken);
      builder.start();
      const id = h.addDoneBook();
      builder.request(id);
      await settled(() => h.producer.isRunning(id));
      broken = id;

      const cancelling = builder.cancel(id);

      await expect(cancelling).resolves.toBeUndefined();
      await tick();
      expect(unhandled).toEqual([]);
    });
  });

  describe("flushing the directory after the renames", () => {
    it.each(["EINVAL", "ENOTSUP", "EPERM", "EISDIR"])(
      "ignores %s, which a file system that cannot sync a directory answers",
      async (code) => {
        await expect(syncDirectory("/x", failingOpen(code))).resolves.toBeUndefined();
      },
    );

    it("does not ignore a real I/O error, and closes the directory either way", async () => {
      const closed: string[] = [];
      const open = (async () => ({
        sync: async () => {
          throw Object.assign(new Error("disk"), { code: "EIO" });
        },
        close: async () => {
          closed.push("closed");
        },
      })) as unknown as typeof import("node:fs/promises").open;

      await expect(syncDirectory("/x", open)).rejects.toMatchObject({ code: "EIO" });
      expect(closed).toEqual(["closed"]);
    });

    it("works on a real directory", async () => {
      await expect(syncDirectory(h.ctx.dataDir)).resolves.toBeUndefined();
    });
  });

  it("does not leave the row building when handling the failure of a build fails too", async () => {
    // A logger that throws makes the failure path itself fail, after the build threw.
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {
        throw new Error("logging is broken");
      },
    };
    const builder = h.restart({ logger });
    builder.start();
    const id = h.addDoneBook();
    builder.request(id);
    await settled(() => h.producer.isRunning(id));

    h.producer.failWith(id, new OutputError("boom"));
    await settled(() => h.state(id) === "failed");

    expect(h.outputs.get(id)?.state).toBe("failed");
    await settled(() => !builder.isBusy(id));
  });
});
