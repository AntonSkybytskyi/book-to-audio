import { describe, expect, it } from "vitest";
import { openArchive } from "./archive.js";
import { zipEpub } from "./testing/build-epub.js";
import { DEFAULT_LIMITS } from "./types.js";

const data = () => zipEpub({ "a.txt": "x".repeat(5000), "b.txt": "hello" });

describe("openArchive", () => {
  // The declared size comes from a private JSZip field. If a JSZip update moves it,
  // every entry would count as 0 bytes and the guard would silently stop working.
  it("reads declared sizes from the zip, so the cap on them works", async () => {
    await expect(
      openArchive(await data(), { ...DEFAULT_LIMITS, maxDeclaredBytes: 1000 }),
    ).rejects.toMatchObject({
      code: "unsafe_archive",
    });
    await expect(
      openArchive(await data(), { ...DEFAULT_LIMITS, maxDeclaredBytes: 6000 }),
    ).resolves.toBeDefined();
  });

  it("rejects too many entries before JSZip builds them", async () => {
    const files = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}`, ""]));

    await expect(
      openArchive(await zipEpub(files), { ...DEFAULT_LIMITS, maxEntries: 100 }),
    ).rejects.toMatchObject({ code: "unsafe_archive" });
  });

  it("reads text and reports missing entries as null", async () => {
    const archive = await openArchive(await data(), DEFAULT_LIMITS);

    expect(await archive.readText("b.txt")).toBe("hello");
    expect(await archive.readText("nope.txt")).toBeNull();
    expect(archive.has("a.txt")).toBe(true);
  });

  it("caps one document even when the shared budget has room", async () => {
    const archive = await openArchive(await data(), { ...DEFAULT_LIMITS, maxDocumentBytes: 1000 });

    await expect(archive.readText("a.txt")).rejects.toMatchObject({ code: "unsafe_archive" });
    expect(await archive.readText("b.txt")).toBe("hello");
  });

  it("decodes UTF-16 with a byte order mark", async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo", "utf16le")]);
    const archive = await openArchive(await zipEpub({ "u.txt": utf16 }), DEFAULT_LIMITS);

    expect(await archive.readText("u.txt")).toBe("héllo");
  });
});
