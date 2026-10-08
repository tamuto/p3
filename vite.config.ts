import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiPort = Number(process.env.PCUBE_PORT ?? 4310);

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    port: Number(process.env.PCUBE_WEB_PORT ?? 5173),
    // API サーバと同じく、DevContainer の外から見られるよう既定で 0.0.0.0 で待ち受ける
    host: process.env.PCUBE_HOST ?? "0.0.0.0",
    proxy: { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
});
