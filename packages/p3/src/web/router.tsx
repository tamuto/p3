import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

// ページは src/web/routes/ のファイル。routeTree.gen.ts は Vite のプラグイン / `pnpm routes` が生成する。
// プロジェクトを跨ぐ serve の tasks の画面では、URL の基点（basepath）を /projects/<名前> にする（この画面の対象。Boot.tsx で決めてから作る）。
// observer のページも同じ基点（プロジェクトを選んでいない /observer だけは /）
export const createAppRouter = (basepath: string) => createRouter({ routeTree, defaultPreload: "intent", basepath });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
