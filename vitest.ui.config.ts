import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// ブラウザで画面を操作する UI テスト（pnpm test:ui。ビルドした画面が要る）。通常の pnpm test とは分ける
export default defineConfig({
  test: {
    include: ["test/ui/**/*.ui.test.ts"],
    environment: "node",
    // Preflight の run の所有者の識別子（core/preflight/owner.ts）を、ホームの ~/.local/state ではなく一時フォルダに作る
    env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "p3-test-state-")) },
    globalSetup: ["test/ui/globalSetup.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // 1つずつ（ブラウザと p3 serve をシナリオごとに起こす）
    fileParallelism: false,
  },
});
