import { crc32 } from "node:zlib";
import fs from "node:fs";
import fsp from "node:fs/promises";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const ZIP64_END_OF_CENTRAL = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;

const UTF8_FLAG = 0x0800;
const U16 = 0xffff;
const U32 = 0xffff_ffff;
const COPY_BYTES = 1024 * 1024;

export interface ZipOptions {
  /** `always` writes ZIP64 records for every entry. */
  zip64?: "auto" | "always";
  /**
   * Where ZIP64 starts: an entry, an offset or the central directory of this many bytes or more, or
   * this many entries or more. The defaults are the limits of the format (4 GB and 65,535); tests
   * lower them, since a real 4 GB archive is not practical.
   */
  limits?: { bytes?: number; entries?: number };
}

interface Entry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
  zip64: boolean;
}

/**
 * Writes a ZIP file one stored (uncompressed) file at a time, never holding a file in memory:
 * Opus is already compressed, so deflating it would only cost time. Names are UTF-8 with the
 * language-encoding flag set. An entry of 4 GB or more, an archive past 4 GB, or more than
 * 65,535 entries get the ZIP64 records; everything else is a plain ZIP that any reader opens.
 *
 * Each source file is read twice, once for its CRC and once to copy it, so that the header holds
 * the real sizes and no data descriptor is needed.
 */
export class ZipWriter {
  private readonly entries: Entry[] = [];
  private offset = 0;
  private closed = false;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  private constructor(
    private readonly handle: fsp.FileHandle,
    private readonly options: ZipOptions,
  ) {
    this.maxBytes = options.limits?.bytes ?? U32;
    this.maxEntries = options.limits?.entries ?? U16;
  }

  /** Creates `filePath`, which must not exist yet. */
  static async create(filePath: string, options: ZipOptions = {}): Promise<ZipWriter> {
    return new ZipWriter(await fsp.open(filePath, "wx", 0o600), options);
  }

  /** Appends the file at `sourcePath` as `name` (a single path segment, already sanitised). */
  async addFile(name: string, sourcePath: string, modified: Date): Promise<void> {
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.length > U16) throw new Error("zip entry name is too long");
    // A small file is read once and written with its header; a large one is read twice (CRC, then copy).
    const small = await readSmall(sourcePath);
    const { crc, size } = small
      ? { crc: crc32(small), size: small.length }
      : await checksum(sourcePath);
    const zip64 =
      this.options.zip64 === "always" || size >= this.maxBytes || this.offset >= this.maxBytes;
    const entry: Entry = {
      name: nameBytes,
      crc,
      size,
      offset: this.offset,
      zip64,
      ...dosTime(modified),
    };

    const extra = zip64 ? zip64Extra([BigInt(size), BigInt(size)]) : Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(entry.dosTime, 10);
    header.writeUInt16LE(entry.dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(zip64 ? U32 : size, 18);
    header.writeUInt32LE(zip64 ? U32 : size, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(extra.length, 28);
    if (small) {
      await this.write(Buffer.concat([header, nameBytes, extra, small]));
      this.entries.push(entry);
      return;
    }
    await this.write(Buffer.concat([header, nameBytes, extra]));

    let copied = 0;
    const source = await fsp.open(sourcePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(COPY_BYTES);
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, copied);
        if (bytesRead === 0) break;
        copied += bytesRead;
        await this.write(buffer.subarray(0, bytesRead));
      }
    } finally {
      await source.close();
    }
    // The header already holds the size and CRC of the first read.
    if (copied !== size) throw new Error(`${name} changed while it was being added to the zip`);
    this.entries.push(entry);
  }

  /** Writes the central directory and closes the file. Returns its size in bytes. */
  async finish(): Promise<number> {
    const centralStart = this.offset;
    for (const entry of this.entries) await this.write(centralRecord(entry, this.maxBytes));
    const centralSize = this.offset - centralStart;

    const needs64 =
      this.options.zip64 === "always" ||
      this.entries.length >= this.maxEntries ||
      centralStart >= this.maxBytes ||
      centralSize >= this.maxBytes;
    if (needs64) {
      const recordOffset = this.offset;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(ZIP64_END_OF_CENTRAL, 0);
      record.writeBigUInt64LE(44n, 4); // bytes that follow this field
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeUInt32LE(0, 16);
      record.writeUInt32LE(0, 20);
      record.writeBigUInt64LE(BigInt(this.entries.length), 24);
      record.writeBigUInt64LE(BigInt(this.entries.length), 32);
      record.writeBigUInt64LE(BigInt(centralSize), 40);
      record.writeBigUInt64LE(BigInt(centralStart), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_LOCATOR, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(recordOffset), 8);
      locator.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([record, locator]));
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL, 0);
    end.writeUInt16LE(needs64 ? U16 : this.entries.length, 8);
    end.writeUInt16LE(needs64 ? U16 : this.entries.length, 10);
    end.writeUInt32LE(needs64 ? U32 : centralSize, 12);
    end.writeUInt32LE(needs64 ? U32 : centralStart, 16);
    await this.write(end);

    await this.handle.sync();
    await this.close();
    return this.offset;
  }

  /** Closes the file without finishing it, after a failure. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }

  private async write(buffer: Buffer): Promise<void> {
    let done = 0;
    while (done < buffer.length) {
      const { bytesWritten } = await this.handle.write(buffer, done, buffer.length - done);
      done += bytesWritten;
    }
    this.offset += buffer.length;
  }
}

function centralRecord(entry: Entry, maxBytes: number): Buffer {
  // Only the fields that do not fit in 32 bits go in the ZIP64 extra field, in this order.
  const bigOffset = entry.offset >= maxBytes;
  const fields: bigint[] = [];
  if (entry.zip64) fields.push(BigInt(entry.size), BigInt(entry.size));
  if (bigOffset) fields.push(BigInt(entry.offset));
  const extra = fields.length > 0 ? zip64Extra(fields) : Buffer.alloc(0);

  const record = Buffer.alloc(46);
  record.writeUInt32LE(CENTRAL_HEADER, 0);
  record.writeUInt16LE((3 << 8) | 45, 4); // made on Unix, ZIP 4.5
  record.writeUInt16LE(fields.length > 0 ? 45 : 20, 6);
  record.writeUInt16LE(UTF8_FLAG, 8);
  record.writeUInt16LE(0, 10);
  record.writeUInt16LE(entry.dosTime, 12);
  record.writeUInt16LE(entry.dosDate, 14);
  record.writeUInt32LE(entry.crc, 16);
  record.writeUInt32LE(entry.zip64 ? U32 : entry.size, 20);
  record.writeUInt32LE(entry.zip64 ? U32 : entry.size, 24);
  record.writeUInt16LE(entry.name.length, 28);
  record.writeUInt16LE(extra.length, 30);
  record.writeUInt16LE(0, 32); // comment
  record.writeUInt16LE(0, 34); // disk
  record.writeUInt16LE(0, 36); // internal attributes
  record.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
  record.writeUInt32LE(bigOffset ? U32 : entry.offset, 42);
  return Buffer.concat([record, entry.name, extra]);
}

function zip64Extra(values: readonly bigint[]): Buffer {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(ZIP64_EXTRA, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(value, 4 + index * 8));
  return extra;
}

/** The whole file when it is small enough to hold in memory, else null. */
async function readSmall(filePath: string): Promise<Buffer | null> {
  const handle = await fsp.open(filePath, "r");
  try {
    if ((await handle.stat()).size > COPY_BYTES) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function checksum(filePath: string): Promise<{ crc: number; size: number }> {
  let crc = 0;
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: COPY_BYTES })) {
    const bytes = chunk as Buffer;
    crc = crc32(bytes, crc);
    size += bytes.length;
  }
  return { crc, size };
}

/** MS-DOS date and time, which ZIP uses. It cannot say anything before 1980 or with odd seconds. */
function dosTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}
