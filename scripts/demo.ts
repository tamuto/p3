/**
 * p3 自体の開発用のデモデータを作る（製品のコードではない。中身は scripts/demoData.ts）。
 *
 *   pnpm demo         .p3-demo/ が無ければ作る（pnpm dev / pnpm start の前に自動で動く）。あれば何もしない
 *   pnpm demo:reset   消して作り直す（手で直した内容も消える）
 *
 * データディレクトリは p3 リポジトリ内に置き（git 管理外）、repo: ".." でリポジトリルートを指す。
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { seedDemo } from "./demoData.ts";

const DEMO_DIR = fileURLToPath(new URL("../.p3-demo", import.meta.url));

if (existsSync(DEMO_DIR)) {
  if (!process.argv.includes("--force")) process.exit(0);
  await rm(DEMO_DIR, { recursive: true });
}
await seedDemo(DEMO_DIR);
console.log(`デモデータを作りました: ${DEMO_DIR}`);
