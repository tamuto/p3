import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { fileURLToPath } from "node:url";
import tsr from "./tsr.config.json" with { type: "json" };

// tsr.config.json のパスはリポジトリのルート基準（CLI と同じ）。Vite の root はアプリの packages/app/src/web なので絶対パスにして渡す。
// ルート一覧はアプリの __root.tsx の下に、機能（tasks・observer）のページのフォルダをそのまま付ける（virtualRouteConfig）。
// ビルドは配布する入口のパッケージの dist/web に出す（入口の CLI が serve に渡す）
const fromRoot = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const apiPort = Number(process.env.P3_PORT ?? 4310);

export default defineConfig({
  root: "packages/app/src/web",
  // アプリの __root.tsx と tasks・observer の packages/tasks/src/web/routes/ のファイルからルート一覧 (routeTree.gen.ts) を作る。react() より前に置く
  plugins: [
    tanstackRouter({
      ...tsr,
      target: "react",
      routesDirectory: fromRoot(tsr.routesDirectory),
      generatedRouteTree: fromRoot(tsr.generatedRouteTree),
    }),
    react(),
    tailwindcss(),
  ],
  build: { outDir: fromRoot("./packages/p3/dist/web"), emptyOutDir: true },
  server: {
    port: Number(process.env.P3_WEB_PORT ?? 5173),
    // API サーバと同じく、DevContainer の外から見られるよう既定で 0.0.0.0 で待ち受ける
    host: process.env.P3_HOST ?? "0.0.0.0",
    proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
