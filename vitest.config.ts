import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    passWithNoTests: true,
    include: [
      "packages/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.{ts,tsx}",
      "evals/test/**/*.test.ts",
    ],
  },
});
