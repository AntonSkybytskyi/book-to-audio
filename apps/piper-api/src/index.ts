import { isExecutable } from "./binary.js";
import { loadConfig } from "./config.js";
import { PiperEngine } from "./piper.js";
import { buildServer } from "./server.js";
import { SynthesisPool } from "./synthesis-pool.js";

async function main() {
  const config = loadConfig();
  const engine = new PiperEngine({
    bin: config.piperBin,
    voicesDir: config.voicesDir,
    scratchDir: config.scratchDir,
    timeoutMs: config.timeoutMs,
    startupGraceMs: config.startupGraceMs,
  });
  engine.removeLeftovers();
  const pool = new SynthesisPool({
    concurrency: config.concurrency,
    idleMs: config.idleMs,
    has: (voiceId) => engine.has(voiceId),
    open: (voiceId) => engine.open(voiceId),
  });
  const app = buildServer({
    logger: true,
    voices: () => engine.voices(),
    pool,
    maxInputChars: config.maxInputChars,
    concurrency: config.concurrency,
    problem: () => {
      if (!isExecutable(config.piperBin)) return `Piper ("${config.piperBin}") is not installed.`;
      if (engine.voices().length === 0) return `No voices are installed in ${config.voicesDir}.`;
      return null;
    },
  });

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      app.log.info(`${signal}: stopping`);
      // Stopping the pool first fails the requests in flight, so closing the server does not wait on them.
      void pool
        .close()
        .then(() => app.close())
        .then(
          () => process.exit(0),
          (error: unknown) => {
            app.log.error({ err: error }, "shutdown failed");
            process.exit(1);
          },
        );
    });
  }

  await app.listen({ host: config.host, port: config.port });
  const voices = engine.voices();
  app.log.info(
    `Piper voices: ${voices.map((v) => v.id).join(", ") || "none"}; ${config.concurrency} at once`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
