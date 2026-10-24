import { TtsError, type PcmAudio } from "./engine.js";

const noAudio = (detail: string) =>
  new TtsError("synthesis_failed", "The speech service sent audio the app cannot read.", {
    detail,
  });

/** The samples of a 16-bit mono PCM WAV file, as the TTS service API sends them. */
export function decodeWav(wav: Buffer): PcmAudio {
  if (
    wav.length < 12 ||
    wav.toString("latin1", 0, 4) !== "RIFF" ||
    wav.toString("latin1", 8, 12) !== "WAVE"
  ) {
    throw noAudio("not a RIFF/WAVE file");
  }
  let sampleRate: number | undefined;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("latin1", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || start + 16 > wav.length) throw noAudio("short fmt chunk");
      const format = wav.readUInt16LE(start);
      const channels = wav.readUInt16LE(start + 2);
      const bits = wav.readUInt16LE(start + 14);
      if (format !== 1 || channels !== 1 || bits !== 16) {
        throw noAudio(
          `format ${format}, ${channels} channels, ${bits} bits; expected 16-bit mono PCM`,
        );
      }
      sampleRate = wav.readUInt32LE(start + 4);
    } else if (id === "data") {
      if (sampleRate === undefined) throw noAudio("data before fmt");
      // A streamed WAV can leave the size unset; then the data runs to the end.
      const end = size === 0 || start + size > wav.length ? wav.length : start + size;
      const samples = wav.subarray(start, end - ((end - start) % 2));
      if (samples.length === 0) {
        throw new TtsError("bad_input", "The speech engine produced no audio for this text.");
      }
      return { sampleRate, channels: 1, samples };
    }
    offset = start + size + (size % 2);
  }
  throw noAudio("no data chunk");
}
