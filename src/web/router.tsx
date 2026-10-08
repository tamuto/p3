import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

// ページは src/web/routes/ のファイル。routeTree.gen.ts は Vite のプラグイン / `pnpm routes` が生成する
export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
