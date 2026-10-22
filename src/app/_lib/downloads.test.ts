import { describe, expect, it } from "vitest";
import { NO_OUTPUTS, type Book, type Outputs } from "./api";
import { downloadsState } from "./downloads";

const book = (status: Book["status"], outputs: Partial<Outputs> = {}, extra: Partial<Book> = {}) =>
  ({
    id: "b",
    status,
    failedCount: 0,
    chapters: [],
    outputs: { ...NO_OUTPUTS, ...outputs },
    ...extra,
  }) as unknown as Book;

const current: Partial<Outputs> = {
  state: "ready",
  available: true,
  progress: 1,
  m4bBytes: 74_000_000,
  zipBytes: 40_000_000,
};

describe("downloadsState", () => {
  it("shows nothing for a book that was not converted", () => {
    expect(downloadsState(book("ready"))).toEqual({ kind: "hidden" });
  });

  it("explains that downloads wait for every chapter while the book is converting", () => {
    for (const status of ["converting", "paused"] as const) {
      expect(downloadsState(book(status))).toEqual({
        kind: "waiting",
        message: "Downloads are ready when every chapter is done.",
      });
    }
  });

  it("asks for the failed chapters to be regenerated when the book finished with errors", () => {
    expect(downloadsState(book("done_with_errors", {}, { failedCount: 2 }))).toMatchObject({
      kind: "waiting",
      message: expect.stringContaining("2 failed chapters to regenerate first"),
    });
  });

  it("offers both files, with their sizes, when they are current", () => {
    expect(downloadsState(book("done", current))).toEqual({
      kind: "ready",
      m4bBytes: 74_000_000,
      zipBytes: 40_000_000,
      rebuild: null,
    });
  });

  it("keeps offering files of the same audio while they are rebuilt, or after a rebuild failed", () => {
    expect(
      downloadsState(book("done", { ...current, state: "building", progress: 0.4 })),
    ).toMatchObject({
      kind: "ready",
      rebuild: { kind: "building", progress: 0.4 },
    });
    expect(downloadsState(book("done", { ...current, state: "queued" }))).toMatchObject({
      kind: "ready",
      rebuild: { kind: "building", progress: null },
    });
    expect(
      downloadsState(
        book("done", { ...current, state: "failed", error: "Chapter 2 is incomplete." }),
      ),
    ).toMatchObject({
      kind: "ready",
      rebuild: { kind: "failed", error: "Chapter 2 is incomplete." },
    });
    expect(downloadsState(book("done", { ...current, state: "failed" }))).toMatchObject({
      rebuild: { kind: "failed", error: "The downloads could not be rebuilt." },
    });
  });

  it("does not offer files for a book that is no longer done, even if the server's flag has not caught up", () => {
    expect(downloadsState(book("converting", { ...current, updating: false }))).toMatchObject({
      kind: "waiting",
    });
    expect(
      downloadsState(book("converting", { ...current, available: false, updating: true })),
    ).toMatchObject({
      kind: "updating",
    });
  });

  it("says the downloads are being updated while a regenerated book rebuilds them", () => {
    expect(
      downloadsState(book("done", { state: "building", updating: true, progress: 0.4 })),
    ).toEqual({ kind: "updating", message: "Updating downloads…", progress: 0.4 });
  });

  it("says they are being prepared, with progress only once the build runs", () => {
    expect(downloadsState(book("done"))).toMatchObject({ kind: "preparing", progress: null });
    expect(downloadsState(book("done", { state: "queued" }))).toMatchObject({
      kind: "preparing",
      progress: null,
    });
    expect(downloadsState(book("done", { state: "building", progress: 0.25 }))).toMatchObject({
      kind: "preparing",
      progress: 0.25,
    });
  });

  it("shows the error of a failed build", () => {
    expect(
      downloadsState(book("done", { state: "failed", error: "Chapter 3 has no audio." })),
    ).toEqual({ kind: "failed", error: "Chapter 3 has no audio." });
    expect(downloadsState(book("done", { state: "failed" }))).toMatchObject({ kind: "failed" });
  });
});
