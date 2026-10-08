import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { fileURLToPath } from "node:url";
import tsr from "./tsr.config.json" with { type: "json" };

// tsr.config.json のパスはリポジトリのルート基準（CLI と同じ）。Vite の root は src/web なので絶対パスにして渡す
const fromRoot = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const apiPort = Number(process.env.PCUBE_PORT ?? 4310);

export default defineConfig({
  root: "src/web",
  // src/web/routes/ のファイルからルート一覧 (routeTree.gen.ts) を作る。react() より前に置く
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
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    port: Number(process.env.PCUBE_WEB_PORT ?? 5173),
    // API サーバと同じく、DevContainer の外から見られるよう既定で 0.0.0.0 で待ち受ける
    host: process.env.PCUBE_HOST ?? "0.0.0.0",
    proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
