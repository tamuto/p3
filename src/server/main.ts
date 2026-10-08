import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadMachineEnv, PCUBE_ROOT } from "./context.ts";
import { seedDemo } from "./scripts/seedDemo.ts";
import { startServer } from "./server.ts";
import { locateDataDir } from "./store/locate.ts";

// 開発用の起動口（pnpm dev / pnpm start）。プロジェクトで使うときは CLI の `pcube serve`。
loadMachineEnv();

let dataDir = locateDataDir();
if (!dataDir) {
  // データディレクトリが見つからなければ、pcube 自身の開発を題材にしたデモで起動する
  dataDir = join(PCUBE_ROOT, ".pcube-demo");
  if (!existsSync(dataDir)) await seedDemo(dataDir);
}

await startServer({
  dataDir,
  port: Number(process.env.PCUBE_PORT ?? 4310),
  // DevContainer の外（ホストのブラウザ）から見られるよう、既定ですべてのインターフェースで待ち受ける
  host: process.env.PCUBE_HOST ?? "0.0.0.0",
  static: process.env.NODE_ENV === "production",
});
