import type { Config } from "../config.js";
import type { TtsEngine } from "./engine.js";
import { FakeEngine } from "./fake.js";
import { PiperEngine } from "./piper.js";

export function createEngine(config: Config): TtsEngine {
  if (config.ttsEngine === "fake") return new FakeEngine({ delayMs: config.fakeTtsDelayMs });
  return new PiperEngine({ bin: config.piperBin, voicesDir: config.piperVoicesDir });
}
