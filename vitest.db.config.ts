import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    include: [
      "src/__tests__/db/**/*.test.ts",
      "src/__tests__/billing.test.ts",
      "src/__tests__/group-access.test.ts",
      "src/__tests__/group-admin.test.ts",
      "src/__tests__/wallet.test.ts",
      "src/app/actions/__tests__/**/*.test.ts",
      "src/app/actions/**/__tests__/**/*.test.ts",
      "src/app/api/**/__tests__/**/*.test.ts",
      "src/lib/queries/**/__tests__/**/*.test.ts",
      "src/lib/__tests__/ai.test.ts",
      "src/lib/__tests__/permissions.test.ts",
      "src/lib/__tests__/referral-splits.test.ts",
      "src/lib/__tests__/work-completion.test.ts",
    ],
    exclude: ["node_modules", "tests/**"],
    globalSetup: "./src/test/setup.ts",
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
  },
});
