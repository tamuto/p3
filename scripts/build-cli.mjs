// 配布物の CLI・serve を JavaScript にする（prepack の pnpm build から呼ぶ）。利用者の環境では tsx（と esbuild）を使わずに動かすため。
//   1. tsc（tsconfig.build.json）で src/{cli,core,server,shared} を lib/ に 1:1 で出す（相対の import の .ts は .js に書き換わる）
//   2. 同じフォルダの .ts 以外の資材（描画のイメージ・Mock の画面・起動の補助）を lib/ の同じ場所に写す
// lib/ は src/ と同じ深さなので、import.meta.url からの相対の参照（../../skills・../../dist/web・./mock-ui.html など）はそのまま効く。
// 開発（このリポジトリの pnpm p3・テスト）はソースのまま動かす（bin/p3.mjs が src/cli/main.ts の有無で決める）
import { execFileSync } from "node:child_process";
import { cpSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "lib");
const LAYERS = ["cli", "core", "server", "shared"];

rmSync(out, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.build.json")], { cwd: root, stdio: "inherit" });

let copied = 0;
const copyAssets = (dir) => {
  for (const name of readdirSync(dir)) {
    const from = join(dir, name);
    if (statSync(from).isDirectory()) copyAssets(from);
    else if (!name.endsWith(".ts")) {
      cpSync(from, join(out, relative(join(root, "src"), from)));
      copied++;
    }
  }
};
for (const l of LAYERS) copyAssets(join(root, "src", l));
console.log(`lib/: CLI・serve を JavaScript にしました（資材 ${copied} 件を写しました）`);
