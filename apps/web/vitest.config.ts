import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "@/": fileURLToPath(new URL("./", import.meta.url)),
      // Tests read the contracts' source, so they run without building it first.
      "@book-to-audio/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { name: "web", environment: "node", include: ["{app,ui}/**/*.test.ts"] },
});
