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
    exclude: [
      "node_modules",
      "tests/**",
      "src/test/**",
      "src/__tests__/billing.test.ts",
      "src/__tests__/group-access.test.ts",
      "src/__tests__/group-admin.test.ts",
      "src/__tests__/wallet.test.ts",
      "src/app/actions/__tests__/**",
      "src/app/actions/**/__tests__/**",
      "src/app/api/**/__tests__/**",
      "src/lib/queries/**/__tests__/**",
      "src/lib/__tests__/ai.test.ts",
      "src/lib/__tests__/permissions.test.ts",
      "src/lib/__tests__/referral-splits.test.ts",
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
  },
});
