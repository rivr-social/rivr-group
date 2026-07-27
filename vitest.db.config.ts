import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
    // next-auth resolves `next/server` through its own nested pnpm directory,
    // which fails without explicit export conditions.
    conditions: ["node", "import", "default"],
  },
  test: {
    environment: "node",
    // Suites that import the auth layer construct NextAuth at module load and
    // refuse to start without a secret. The value is never used to sign
    // anything a test asserts on; `env.test.ts` (CI config) manages its own.
    env: { AUTH_SECRET: "test-auth-secret-not-a-real-key" },
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
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
      "src/lib/__tests__/settlement-splits.test.ts",
      "src/lib/__tests__/lineage-distribution.test.ts",
      // NOT included, and deliberately so — see open-issues.md (2026-07-26):
      // `group-action-tools.test.ts` and `group-federation-mutations-route.test.ts`
      // are database-backed but ran in NO config for months, so they drifted
      // from the code (stale buildProjectListing expectations, a missing
      // `getResourcesByOwnerSubtreeAndType` mock export, an Auth.js Drizzle
      // adapter error). They are excluded from the unit config too. Repair
      // them and add them here; do not leave them running nowhere again.
    ],
    exclude: ["node_modules", "tests/**"],
    globalSetup: "./src/test/setup.ts",
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    // These suites share ONE database, so detached writes cross transaction
    // boundaries between files when they run in parallel — global reported ~145
    // spurious failures that all passed when run individually. Serialize until
    // each worker gets its own database.
    fileParallelism: false,
  },
});
