import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    include: [
      "src/lib/__tests__/env.test.ts",
      "src/lib/__tests__/stripe-config.test.ts",
      "src/lib/__tests__/checkout-fees.test.ts",
      "src/lib/__tests__/route-access.test.ts",
      "src/lib/__tests__/matrix-admin.test.ts",
    ],
    pool: "forks",
  },
});
