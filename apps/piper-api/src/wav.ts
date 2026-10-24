/** Raw 16-bit little-endian mono PCM. */
export interface PcmAudio {
  sampleRate: number;
  channels: 1;
  samples: Buffer;
}

const HEADER_BYTES = 44;

/** A WAV file holding `audio`. */
export function encodeWav({ sampleRate, samples }: PcmAudio): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(HEADER_BYTES - 8 + samples.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per sample
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "latin1");
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}
