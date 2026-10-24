import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  // Tests read the contracts' source, so they run without building it first.
  resolve: {
    alias: {
      "@book-to-audio/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    name: "piper-api",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Tests that start processes or build files are slow when the machine is busy with other work.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
