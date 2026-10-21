import { fileURLToPath } from "node:url";
import nextModule from "next";
import { buildServer } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";

// `next` is CommonJS with `module.exports = createServer`, so under NodeNext the
// default import is the function at runtime but is typed as the module namespace.
// This file is type-checked only by tsconfig.server.json (NodeNext) for that reason.
const next = nextModule as unknown as typeof nextModule.default;

// Same depth from src/server (tsx) and dist/server (built).
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dataDir);

  const nextApp = next({
    dev: config.dev,
    dir: projectRoot,
    hostname: config.host,
    port: config.port,
  });
  await nextApp.prepare();

  const app = buildServer({ db, nextHandler: nextApp.getRequestHandler(), logger: true });

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info(`${signal} received, shutting down`);
    // Long-lived responses can keep the server open; don't wait past Docker's stop timeout.
    setTimeout(() => process.exit(1), 8000).unref();
    let code = 0;
    try {
      await app.close();
      await nextApp.close();
    } catch (error) {
      app.log.error({ err: error }, "error during shutdown");
      code = 1;
    } finally {
      db.close();
    }
    process.exit(code);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`data directory: ${config.dataDir}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
