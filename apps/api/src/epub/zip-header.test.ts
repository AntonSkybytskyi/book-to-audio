import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { countZipEntries } from "./zip-header.js";

const zipWith = async (names: string[], options: { comment?: string } = {}) => {
  const zip = new JSZip();
  for (const name of names) zip.file(name, "", { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer", comment: options.comment });
};

describe("countZipEntries", () => {
  it("counts the entries of a zip", async () => {
    expect(countZipEntries(await zipWith(["a", "b", "c"]), 100)).toBe(3);
  });

  it("counts an empty zip as zero", async () => {
    expect(countZipEntries(await zipWith([]), 100)).toBe(0);
  });

  it("stops counting just past the limit", async () => {
    const names = Array.from({ length: 500 }, (_, i) => `f${i}`);

    expect(countZipEntries(await zipWith(names), 100)).toBe(101);
  });

  it("finds the end record behind a zip comment", async () => {
    expect(countZipEntries(await zipWith(["a", "b"], { comment: "x".repeat(300) }), 100)).toBe(2);
  });

  it("is not fooled by a forged entry count in the end record", async () => {
    const data = await zipWith(Array.from({ length: 50 }, (_, i) => `f${i}`));
    const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    data.writeUInt16LE(1, eocd + 8); // entries on this disk
    data.writeUInt16LE(1, eocd + 10); // total entries

    expect(countZipEntries(data, 10)).toBe(11);
  });

  it("copes with data in front of the archive", async () => {
    const zip = await zipWith(["a", "b", "c"]);

    expect(countZipEntries(Buffer.concat([Buffer.from("prefix-bytes"), zip]), 100)).toBe(3);
  });

  it.each([Buffer.alloc(0), Buffer.from("not a zip"), Buffer.alloc(100, 0x50)])(
    "returns null for data that is not a zip",
    (data) => {
      expect(countZipEntries(data, 100)).toBeNull();
    },
  );

  it("returns null for a truncated archive", async () => {
    const zip = await zipWith(["a", "b"]);

    expect(countZipEntries(zip.subarray(0, zip.length - 5), 100)).toBeNull();
  });
});
