const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_FIXED_BYTES = 46;
const EOCD_FIXED_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

/**
 * Counts the entries of a zip by walking its central directory, stopping once
 * `limit` is passed. This runs before JSZip loads the archive: JSZip builds an
 * object per entry, so a file with hundreds of thousands of empty entries costs
 * gigabytes. The walk follows the real headers, not the (forgeable) entry count
 * in the end-of-central-directory record.
 *
 * Returns null when the data does not look like a zip; JSZip then reports it.
 */
export function countZipEntries(data: Buffer, limit: number): number | null {
  const eocd = findEocd(data);
  if (eocd === null) return null;

  let directorySize = data.readUInt32LE(eocd + 12);
  let directoryOffset = data.readUInt32LE(eocd + 16);
  let directoryEnd = eocd;

  // Zip64: the real values live in a separate record before the EOCD.
  if (directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || data.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) return null;
    const zip64 = Number(data.readBigUInt64LE(locator + 8));
    if (!Number.isSafeInteger(zip64) || zip64 + 56 > data.length) return null;
    if (data.readUInt32LE(zip64) !== ZIP64_EOCD_SIGNATURE) return null;
    directorySize = Number(data.readBigUInt64LE(zip64 + 40));
    directoryOffset = Number(data.readBigUInt64LE(zip64 + 48));
    directoryEnd = zip64;
  }

  // Archives with data in front of them store offsets relative to the zip start.
  const candidates = [directoryOffset, directoryEnd - directorySize];
  const start = candidates.find(
    (offset) =>
      offset >= 0 &&
      offset + 4 <= data.length &&
      data.readUInt32LE(offset) === CENTRAL_HEADER_SIGNATURE,
  );
  if (start === undefined) return directorySize === 0 ? 0 : null;

  let count = 0;
  let position = start;
  while (
    position + CENTRAL_HEADER_FIXED_BYTES <= data.length &&
    data.readUInt32LE(position) === CENTRAL_HEADER_SIGNATURE
  ) {
    if (++count > limit) return count;
    const nameLength = data.readUInt16LE(position + 28);
    const extraLength = data.readUInt16LE(position + 30);
    const commentLength = data.readUInt16LE(position + 32);
    position += CENTRAL_HEADER_FIXED_BYTES + nameLength + extraLength + commentLength;
  }
  return count;
}

function findEocd(data: Buffer): number | null {
  const lowest = Math.max(0, data.length - EOCD_FIXED_BYTES - MAX_COMMENT_BYTES);
  for (let i = data.length - EOCD_FIXED_BYTES; i >= lowest; i--) {
    if (data.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    // The comment must run exactly to the end of the file.
    if (i + EOCD_FIXED_BYTES + data.readUInt16LE(i + 20) === data.length) return i;
  }
  return null;
}
