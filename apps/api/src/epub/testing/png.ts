import zlib from "node:zlib";

type Rgb = readonly [number, number, number];

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return out;
}

/** Encodes an RGB image. `pixel(x, y)` returns the colour of each pixel. */
export function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgb,
): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    rows[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      rows.set([r, g, b], row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A plain book cover: a flat colour with a lighter band and a thin inner frame. */
export function makeCover(background: Rgb, band: Rgb, width = 300, height = 450): Buffer {
  return makePng(width, height, (x, y) => {
    const frame = x === 14 || x === width - 15 || y === 14 || y === height - 15;
    if (frame && x >= 14 && x <= width - 15 && y >= 14 && y <= height - 15) return band;
    return y > height * 0.55 && y < height * 0.62 ? band : background;
  });
}
