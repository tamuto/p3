import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // ブラウザの UI テストは vitest.ui.config.ts（pnpm test:ui）
    exclude: [...configDefaults.exclude, "test/ui/**"],
    environment: "node",
    testTimeout: 20_000,
  },
});
