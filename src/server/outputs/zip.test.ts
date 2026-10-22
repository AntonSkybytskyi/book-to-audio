import { crc32 } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZipWriter, type ZipOptions } from "./zip.js";

describe("ZipWriter", () => {
  let dir: string;
  const when = new Date(2026, 4, 17, 9, 30, 42);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: Buffer | string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  };

  const build = async (
    files: { name: string; content: Buffer | string }[],
    options?: ZipOptions,
  ) => {
    const target = path.join(dir, "out.zip");
    const writer = await ZipWriter.create(target, options);
    for (const [i, file] of files.entries()) {
      await writer.addFile(file.name, write(`src-${i}`, file.content), when);
    }
    const size = await writer.finish();
    return { target, size };
  };

  it("writes stored entries that an independent reader opens, with matching CRCs", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const { target, size } = await build([
      { name: "01 - One.webm", content: "first file" },
      { name: "02 - Two.webm", content: big },
      { name: "03 - Empty.webm", content: "" },
    ]);

    const bytes = fs.readFileSync(target);
    expect(bytes.length).toBe(size);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    expect(Object.keys(zip.files)).toEqual(["01 - One.webm", "02 - Two.webm", "03 - Empty.webm"]);
    expect(await zip.file("01 - One.webm")?.async("string")).toBe("first file");
    expect(crc32(Buffer.from((await zip.file("02 - Two.webm")?.async("uint8array")) ?? []))).toBe(
      crc32(big),
    );
    expect((await zip.file("03 - Empty.webm")?.async("string"))?.length).toBe(0);
  });

  it("stores without compression and flags the names as UTF-8", async () => {
    const { target } = await build([
      { name: "01 - Глава «Київ» 第一章.webm", content: "x".repeat(1000) },
    ]);

    const bytes = fs.readFileSync(target);
    // Local file header: signature, version, flags, method, ... name length at 26.
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(bytes.readUInt16LE(6) & 0x0800).toBe(0x0800);
    expect(bytes.readUInt16LE(8)).toBe(0);
    expect(bytes.readUInt32LE(18)).toBe(1000); // compressed size equals the size: stored
    expect(bytes.readUInt32LE(22)).toBe(1000);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toEqual(["01 - Глава «Київ» 第一章.webm"]);
  });

  it("records the time and a regular-file mode in the directory", async () => {
    const { target } = await build([{ name: "a.webm", content: "a" }]);

    const zip = await JSZip.loadAsync(fs.readFileSync(target));
    const date = zip.file("a.webm")?.date;
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(4);
    expect(date?.getDate()).toBe(17);
    expect(date?.getMinutes()).toBe(30);
    const unix = zip.file("a.webm")?.unixPermissions;
    expect(Number(unix) & 0o777).toBe(0o644);
  });

  it("writes ZIP64 records that an independent reader opens", async () => {
    const { target } = await build(
      [
        { name: "01 - One.webm", content: "first file" },
        { name: "02 - Two.webm", content: "second" },
      ],
      { zip64: "always" },
    );

    const bytes = fs.readFileSync(target);
    expect(bytes.readUInt16LE(4)).toBe(45); // needs ZIP 4.5
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true); // ZIP64 end record
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07]))).toBe(true); // and its locator
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    expect(await zip.file("01 - One.webm")?.async("string")).toBe("first file");
    expect(await zip.file("02 - Two.webm")?.async("string")).toBe("second");
  });

  it("promotes only what does not fit: a big entry, a far offset, the central directory, or too many entries", async () => {
    // Limits of 40 bytes stand in for 4 GB: the second and later entries start past 40, the third is 60 bytes.
    const files = [
      { name: "a.webm", content: "tiny" },
      { name: "b.webm", content: "second" },
      { name: "c.webm", content: "x".repeat(60) },
    ];

    const { target } = await build(files, { limits: { bytes: 40 } });

    const bytes = fs.readFileSync(target);
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    expect(Object.keys(zip.files)).toEqual(["a.webm", "b.webm", "c.webm"]);
    expect(await zip.file("a.webm")?.async("string")).toBe("tiny");
    expect(await zip.file("b.webm")?.async("string")).toBe("second");
    expect(await zip.file("c.webm")?.async("string")).toBe("x".repeat(60));
  });

  it("writes ZIP64 end records once there are too many entries, with every entry readable", async () => {
    const files = Array.from({ length: 7 }, (_, i) => ({
      name: `${i}.webm`,
      content: `file ${i}`,
    }));

    const { target } = await build(files, { limits: { entries: 5 } });

    const bytes = fs.readFileSync(target);
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
    // The plain end record says "see the ZIP64 record" for the counts.
    expect(bytes.readUInt16LE(bytes.length - 22 + 10)).toBe(0xffff);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    expect(Object.keys(zip.files)).toHaveLength(7);
    expect(await zip.file("6.webm")?.async("string")).toBe("file 6");
  });

  it("holds 65,536 entries, one more than a plain ZIP can count, and reads back every one", async () => {
    const target = path.join(dir, "many.zip");
    const writer = await ZipWriter.create(target);
    const source = write("one", "payload");
    for (let i = 0; i < 65_536; i++) await writer.addFile(`${i}.webm`, source, when);
    await writer.finish();

    const bytes = fs.readFileSync(target);
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toHaveLength(65_536);
    expect(await zip.file("65535.webm")?.async("string")).toBe("payload");
  }, 60_000);

  it("keeps a plain ZIP free of ZIP64 records", async () => {
    const { target } = await build([{ name: "a.webm", content: "a" }]);

    const bytes = fs.readFileSync(target);
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(false);
    expect(bytes.readUInt16LE(4)).toBe(20);
  });

  it("refuses to overwrite a file that exists", async () => {
    const target = path.join(dir, "out.zip");
    fs.writeFileSync(target, "already here");

    await expect(ZipWriter.create(target)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("fails on a source that does not exist and can still be closed", async () => {
    const writer = await ZipWriter.create(path.join(dir, "out.zip"));

    await expect(writer.addFile("a.webm", path.join(dir, "missing"), when)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(writer.close()).resolves.toBeUndefined();
    await expect(writer.close()).resolves.toBeUndefined();
  });
});
