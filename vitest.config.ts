import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Tests that start processes or build files are slow when the machine is busy with other work.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
