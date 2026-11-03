import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // ブラウザの UI テストは vitest.ui.config.ts（pnpm test:ui）
    exclude: [...configDefaults.exclude, "test/ui/**"],
    environment: "node",
    testTimeout: 20_000,
    // Preflight の run の所有者の識別子（core/preflight/owner.ts）を、ホームの ~/.local/state ではなく一時フォルダに作る
    env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "p3-test-state-")) },
  },
});
