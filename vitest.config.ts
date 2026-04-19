import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest configuration for rivr-group.
 *
 * The runtime code uses `@/*` path aliases that map to `./src/*`. Without this
 * config, vitest cannot resolve those imports and every test in `src/__tests__`
 * fails at module load. Mirrors the mapping declared in `tsconfig.json`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
