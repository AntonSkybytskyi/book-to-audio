import path from "node:path";
import { describe, expect, it } from "vitest";
import { Storage } from "./storage.js";

describe("Storage", () => {
  const storage = new Storage("/data");
  const id = "6f1c1b34-8d5b-4f64-9f0a-5a2d3f0c9d11";

  it("builds paths from ids and positions", () => {
    expect(storage.sourceRelPath(id)).toBe(`books/${id}/source.epub`);
    expect(storage.coverRelPath(id, "image/png")).toBe(`books/${id}/cover.png`);
    expect(storage.audioRelPath(id, 3)).toBe(`audio/${id}/03.webm`);
    expect(storage.audioRelPath(id, 120)).toBe(`audio/${id}/120.webm`);
  });

  it("keeps the downloads of a book in the outputs area, which delete and the sweep cover", () => {
    expect(storage.outputFile(id, "m4b")).toBe(path.join("/data", "outputs", id, "book.m4b"));
    expect(storage.outputFile(id, "zip")).toBe(path.join("/data", "outputs", id, "book.zip"));
    expect(storage.bookAreas).toContain("outputs");
  });

  it("has no cover path for unsupported image types", () => {
    expect(storage.coverRelPath(id, "image/svg+xml")).toBeNull();
  });

  it("resolves relative paths inside the data directory", () => {
    expect(storage.resolve(`books/${id}/cover.png`)).toBe(
      path.join("/data", "books", id, "cover.png"),
    );
  });

  it("refuses paths that escape the data directory", () => {
    expect(() => storage.resolve("../etc/passwd")).toThrow(/escapes/);
    expect(() => storage.resolve("/etc/passwd")).toThrow(/escapes/);
    expect(() => storage.resolve("books/../../x")).toThrow(/escapes/);
  });
});
