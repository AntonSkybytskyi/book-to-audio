import fs from "node:fs";
import path from "node:path";
import { runProcess, type ProcessRunner } from "../process.js";
import {
  TtsError,
  type PcmAudio,
  type SynthesizeRequest,
  type TtsEngine,
  type Voice,
} from "./engine.js";

export interface PiperOptions {
  /** The `piper` executable. */
  bin: string;
  /** Directory with `<voice>.onnx` and `<voice>.onnx.json` files. */
  voicesDir: string;
  timeoutMs?: number;
  run?: ProcessRunner;
  /** How long a scan of the voices directory is reused. */
  scanTtlMs?: number;
  now?: () => number;
}

interface VoiceFile extends Voice {
  modelPath: string;
  sampleRate: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SCAN_TTL_MS = 30_000;

/** Runs the Piper binary once per chunk: text on stdin, raw 16-bit PCM on stdout. */
export class PiperEngine implements TtsEngine {
  readonly id = "piper";
  readonly kind = "local";
  readonly maxInputChars = 1000;
  private readonly options: Required<PiperOptions>;
  private cache: VoiceFile[] = [];
  private scannedAt = Number.NEGATIVE_INFINITY;

  constructor(options: PiperOptions) {
    this.options = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      run: runProcess,
      scanTtlMs: DEFAULT_SCAN_TTL_MS,
      now: Date.now,
      ...options,
    };
  }

  voices(): Voice[] {
    return this.scan().map(({ id, language, name }) => ({ id, language, name }));
  }

  async synthesize({ text, voiceId, speed, signal }: SynthesizeRequest): Promise<PcmAudio> {
    const voice = this.scan().find((v) => v.id === voiceId);
    if (!voice) throw new TtsError("voice_not_found", `Piper has no voice "${voiceId}"`);
    if (text.length > this.maxInputChars) {
      throw new TtsError(
        "synthesis_failed",
        `Text is longer than ${this.maxInputChars} characters`,
      );
    }

    // Piper speaks one line at a time, so line breaks only mark paragraphs.
    const args = ["--model", voice.modelPath, "--output_raw", "--length_scale", String(1 / speed)];
    let result;
    try {
      result = await this.options.run(this.options.bin, args, {
        input: `${text.trim()}\n`,
        timeoutMs: this.options.timeoutMs,
        signal,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TtsError("engine_unavailable", "The speech engine (Piper) is not installed.", {
          cause: error,
          detail: `"${this.options.bin}" was not found`,
        });
      }
      throw new TtsError("synthesis_failed", "The speech engine could not be started.", {
        cause: error,
        detail: (error as Error).message,
      });
    }

    if (result.aborted) throw new TtsError("aborted", "Synthesis was cancelled");
    if (result.timedOut) {
      throw new TtsError("timeout", "The speech engine took too long on this chapter.", {
        detail: `Piper took longer than ${this.options.timeoutMs / 1000} s`,
      });
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
      throw new TtsError("synthesis_failed", "The speech engine failed on this chapter.", {
        detail: `Piper exited with code ${result.code}: ${detail}`,
      });
    }
    // Whole 16-bit samples only.
    const samples = result.stdout.subarray(0, result.stdout.length - (result.stdout.length % 2));
    if (samples.length === 0)
      throw new TtsError("synthesis_failed", "The speech engine produced no audio.");
    return { sampleRate: voice.sampleRate, channels: 1, samples };
  }

  private scan(): VoiceFile[] {
    // Reused for a short while, so a voice added later is found without a restart.
    const now = this.options.now();
    if (now - this.scannedAt < this.options.scanTtlMs) return this.cache;
    this.scannedAt = now;

    let names: string[];
    try {
      names = fs.readdirSync(this.options.voicesDir);
    } catch {
      this.cache = [];
      return this.cache;
    }
    const voices: VoiceFile[] = [];
    for (const name of names.filter((n) => n.endsWith(".onnx")).toSorted()) {
      const voice = readVoice(path.join(this.options.voicesDir, name));
      if (voice) voices.push(voice);
    }
    this.cache = voices;
    return voices;
  }
}

function readVoice(modelPath: string): VoiceFile | null {
  try {
    const config = JSON.parse(fs.readFileSync(`${modelPath}.json`, "utf8")) as {
      audio?: { sample_rate?: number };
      language?: { family?: string; code?: string };
    };
    const id = path.basename(modelPath, ".onnx");
    const language = config.language?.family ?? config.language?.code?.split(/[_-]/)[0];
    const sampleRate = config.audio?.sample_rate;
    if (!language || !sampleRate) return null;
    return { id, language: language.toLowerCase(), name: id, modelPath, sampleRate };
  } catch {
    return null; // Missing or unreadable config: the voice is not usable.
  }
}
