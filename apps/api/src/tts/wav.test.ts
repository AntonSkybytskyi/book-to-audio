import { describe, expect, it } from "vitest";
import { decodeWav } from "./wav.js";

const chunk = (id: string, body: Buffer) => {
  const head = Buffer.alloc(8);
  head.write(id, 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const fmt = ({ format = 1, channels = 1, sampleRate = 22050, bits = 16 } = {}) => {
  const body = Buffer.alloc(16);
  body.writeUInt16LE(format, 0);
  body.writeUInt16LE(channels, 2);
  body.writeUInt32LE(sampleRate, 4);
  body.writeUInt32LE((sampleRate * channels * bits) / 8, 8);
  body.writeUInt16LE((channels * bits) / 8, 12);
  body.writeUInt16LE(bits, 14);
  return chunk("fmt ", body);
};
const riff = (...chunks: Buffer[]) => {
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), ...chunks]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

describe("decodeWav", () => {
  it("returns the samples and the sample rate, skipping other chunks", () => {
    const wav = riff(
      fmt({ sampleRate: 16000 }),
      chunk("LIST", Buffer.alloc(5)),
      chunk("data", Buffer.from([1, 0, 2, 0])),
    );

    expect(decodeWav(wav)).toEqual({
      sampleRate: 16000,
      channels: 1,
      samples: Buffer.from([1, 0, 2, 0]),
    });
  });

  it("reads to the end when the data size is unset", () => {
    const wav = Buffer.concat([
      riff(fmt()),
      Buffer.from("data", "latin1"),
      Buffer.alloc(4),
      Buffer.from([5, 0, 6, 0, 7]),
    ]);

    expect(decodeWav(wav).samples).toEqual(Buffer.from([5, 0, 6, 0])); // whole samples only
  });

  it.each([
    ["stereo", { channels: 2 }],
    ["8-bit", { bits: 8 }],
    ["float", { format: 3 }],
  ])("refuses %s audio", (_name, options) => {
    expect(() => decodeWav(riff(fmt(options), chunk("data", Buffer.alloc(4))))).toThrow(
      expect.objectContaining({ code: "synthesis_failed" }),
    );
  });

  it("refuses anything that is not a WAV with data", () => {
    expect(() => decodeWav(Buffer.from("nope"))).toThrow(
      expect.objectContaining({ code: "synthesis_failed" }),
    );
    expect(() => decodeWav(riff(fmt()))).toThrow(
      expect.objectContaining({ code: "synthesis_failed" }),
    );
    expect(() => decodeWav(riff(chunk("data", Buffer.alloc(4))))).toThrow(
      expect.objectContaining({ code: "synthesis_failed" }),
    );
  });

  it("calls a WAV without samples unreadable text, not a broken service", () => {
    expect(() => decodeWav(riff(fmt(), chunk("data", Buffer.alloc(0))))).toThrow(
      expect.objectContaining({ code: "bad_input" }),
    );
  });
});
