import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TtsServiceVoice } from "@book-to-audio/contracts";
import { TtsError } from "./errors.js";
import { PiperSession } from "./piper-session.js";
import { compareVoiceFiles, defaultSpeaker } from "./voices.js";

export interface PiperOptions {
  /** The `piper` executable. */
  bin: string;
  /** Directory with `<voice>.onnx` and `<voice>.onnx.json` files. */
  voicesDir: string;
  /**
   * Parent of the scratch folders where sessions keep the WAV files Piper writes.
   * Each service process uses `piper-<pid>` inside it; `removeLeftovers` clears dead ones.
   */
  scratchDir?: string;
  /** Longest wait for one chunk. */
  timeoutMs?: number;
  /** Extra wait for the first chunk of a session, which loads the model. */
  startupGraceMs?: number;
  /** How long a scan of the voices directory is reused. */
  scanTtlMs?: number;
  now?: () => number;
  /** Told why voices cannot be used, each time that changes. */
  logger?: { warn(message: string): void };
}

interface VoiceFile extends TtsServiceVoice {
  modelPath: string;
  /** Piper's number for `speaker`, passed with every chunk. */
  speakerId?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STARTUP_GRACE_MS = 60_000;
const DEFAULT_SCAN_TTL_MS = 30_000;

/** Runs the Piper binary, one long-lived process per session. */
export class PiperEngine {
  private readonly options: Required<PiperOptions>;
  private cache: VoiceFile[] = [];
  private scannedAt = Number.NEGATIVE_INFINITY;
  private reported = "";

  constructor(options: PiperOptions) {
    this.options = {
      scratchDir: path.join(os.tmpdir(), `book-to-audio-${process.getuid?.() ?? "user"}`),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      startupGraceMs: DEFAULT_STARTUP_GRACE_MS,
      scanTtlMs: DEFAULT_SCAN_TTL_MS,
      now: Date.now,
      logger: { warn: () => {} },
      ...options,
    };
  }

  /** The usable voices, the default ones first. */
  voices(): TtsServiceVoice[] {
    return this.scan().map(({ id, language, name, sampleRate, speaker }) => ({
      id,
      language,
      name,
      sampleRate,
      ...(speaker === undefined ? {} : { speaker }),
    }));
  }

  has(voiceId: string): boolean {
    return this.scan().some((v) => v.id === voiceId);
  }

  async open(voiceId: string): Promise<PiperSession> {
    const voice = this.scan().find((v) => v.id === voiceId);
    if (!voice) throw new TtsError("voice_not_found", `Piper has no voice "${voiceId}"`);
    return PiperSession.open({
      bin: this.options.bin,
      modelPath: voice.modelPath,
      sampleRate: voice.sampleRate,
      speakerId: voice.speakerId,
      scratchRoot: path.join(this.options.scratchDir, `piper-${process.pid}`),
      timeoutMs: this.options.timeoutMs,
      startupGraceMs: this.options.startupGraceMs,
    });
  }

  /**
   * Removes the scratch folders of service processes that are gone. Call once at startup, when
   * a folder with this process's own id is also a leftover (in Docker the id is always 1).
   */
  removeLeftovers(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.options.scratchDir);
    } catch {
      return;
    }
    for (const name of names) {
      const match = /^piper-(\d+)$/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid === process.pid || !isAlive(pid)) {
        fs.rmSync(path.join(this.options.scratchDir, name), { recursive: true, force: true });
      }
    }
  }

  private scan(): VoiceFile[] {
    // Reused for a short while, so a voice added later is found without a restart.
    const now = this.options.now();
    if (now - this.scannedAt < this.options.scanTtlMs) return this.cache;
    this.scannedAt = now;

    let names: string[];
    try {
      names = fs.readdirSync(this.options.voicesDir);
    } catch (error) {
      this.report([`cannot read ${this.options.voicesDir}: ${(error as Error).message}`]);
      this.cache = [];
      return this.cache;
    }
    const voices: VoiceFile[] = [];
    const problems: string[] = [];
    const models = names.filter((n) => n.endsWith(".onnx"));
    for (const name of models.toSorted((a, b) =>
      compareVoiceFiles(a.slice(0, -5), b.slice(0, -5)),
    )) {
      const voice = readVoice(path.join(this.options.voicesDir, name));
      if (typeof voice === "string") problems.push(`${name}: ${voice}`);
      else voices.push(voice);
    }
    this.report(problems);
    this.cache = voices;
    return voices;
  }

  /** Logs the problems of a scan, unless the last scan had the same ones. */
  private report(problems: string[]): void {
    const text = problems.join("; ");
    if (text === this.reported) return;
    this.reported = text;
    if (text) this.options.logger.warn(`Piper voices that cannot be used: ${text}`);
  }
}

/** The voice of a model, or why it cannot be used. */
function readVoice(modelPath: string): VoiceFile | string {
  try {
    const config = JSON.parse(fs.readFileSync(`${modelPath}.json`, "utf8")) as {
      audio?: { sample_rate?: number };
      language?: { family?: string; code?: string };
      num_speakers?: number;
      speaker_id_map?: Record<string, number>;
    };
    const model = path.basename(modelPath, ".onnx");
    const language = config.language?.family ?? config.language?.code?.split(/[_-]/)[0];
    const sampleRate = config.audio?.sample_rate;
    if (!language) return "its config names no language";
    if (!sampleRate) return "its config has no sample rate";
    const base = { language: language.toLowerCase(), sampleRate, modelPath };
    if ((config.num_speakers ?? 1) <= 1) return { ...base, id: model, name: model };
    // A model with several speakers is one voice: the default speaker, named in the id.
    const speaker = defaultSpeaker(model, config.speaker_id_map ?? {});
    if (!speaker) return "its config lacks the speaker this voice uses";
    const id = `${model}:${speaker.name}`;
    return { ...base, id, name: id, speaker: speaker.name, speakerId: speaker.id };
  } catch (error) {
    return `no readable config: ${(error as Error).message}`;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // Someone else's process still exists.
  }
}
