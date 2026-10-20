import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import { pageBase } from "./lib/scope.ts";

// ページは src/web/routes/ のファイル。routeTree.gen.ts は Vite のプラグイン / `pnpm routes` が生成する。
// プロジェクトを跨ぐ serve では、URL の基点（basepath）を /projects/<名前> にする（この画面の対象。Boot.tsx で決めてから作る）
export const createAppRouter = () => createRouter({ routeTree, defaultPreload: "intent", basepath: pageBase() });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
