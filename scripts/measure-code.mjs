#!/usr/bin/env node
// コード量を数える（重複の整理とモジュール構成の組み直し 261119-vwgf8 の前後の比較。docs/refactoring.md「計測の定義」）。
//
//   node scripts/measure-code.mjs [--root <チェックアウト>] [--json]
//
// 数えるもの: packages/*/src と packages/p3/bin の .ts・.tsx・.mjs（製品のコード）、test/ の同じ拡張子（ユニットテストと test/ui の UI テスト）。
// 除くもの: 生成したルート一覧（*.gen.ts）、node_modules、ビルドの出力（lib・dist・build-src）、.ts 以外の資材（.md・.html・.png・Dockerfile など）、
// コンテナの中で動く描画のスクリプト（core/preflight/render-image/）。行は改行の数（空行・コメントも含む。コメントの行数は別に出す）。
// 機能の分け方は下の FEATURES（パスの語で決めるので、ファイルを機能ごとのフォルダに移しても同じ機能として数える）。どれにも当たらないものは「未分類」。
// 依存を使わない（Node だけで動く）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const root = resolve(args.includes("--root") ? args[args.indexOf("--root") + 1] : fileURLToPath(new URL("..", import.meta.url)));

/** 機能（上から順に当てる。パスの区切りを / にした相対パスで照らす） */
export const FEATURES = [
  ["入口（起動・振り分け・AI 向けの入口）", /^packages\/p3\/(bin|src\/cli)\//],
  ["入口（serve・画面の外枠）", /^packages\/p3\/src\/(server|core|web)\//],
  ["kit", /^packages\/kit\//],
  ["開発の指標", /metric/i],
  ["振り返り", /retro/i],
  ["タスクの AI レビュー", /taskReview/i],
  ["マイルストーンレビュー", /milestoneReview/i],
  ["リリースノート", /release[-_]?notes?|releaseGenerat|summariz/i],
  ["品質基準・改善要望", /quality|improvement/i],
  ["完了の記録・手戻り・見直し候補・前提", /completion(Record|Refs|Review)|reworkHistory|reviewCandidate|revisit|premise|completeRequests/i],
  ["AI の実行の共通（run）", /reviewRuns|runControl|\/runs?\//i],
  ["AI 接続・実行環境（Codex・ChatGPT・Docker）", /chatgpt|codex|docker|hostPaths|redact|launch(er)?\.|render(Image)?\b|\/render\.ts|uiRender/i],
  ["Preflight（評価・案・分割・画面資料）", /preflight|draft|clarif|carryover|split|uiMaterial|wireframe|mockEngine|engine\.ts|instructions|xlsx|childDrafts|supersede/i],
  ["受け入れ基準・証拠", /acceptance|evidence|criteria/i],
  ["要求の根拠・確認・回答", /requirement|answer|clarif/i],
  ["タスク（状態・停止・作業先・アーカイブ）", /task(Block|Commands|Drawer)|\/tasks?\b|board|workTarget|archived|directTask|outputs?\b/i],
  ["要望（親子・進捗・検索・メモ・添付）", /request|hierarchy|child|progress|\/ops\.ts|scope|tag|note|attachment|milestone/i],
  ["保存（ファイル・コレクション・監視）", /\/store\/|collection|workspace|normalize|frontmatter|fsutil|dataWatcher/i],
  ["設定・プロジェクト・個人設定", /userConfig|machineSettings|project|settings|locate|repo|theme|readOnly|usage|actor|context\.ts|appInfo|preflightRunner/i],
  ["エラーの対応の表（CLI・API）", /errorOutcome/],
  ["API の組み立て", /\/server\//],
  ["CLI の共通（引数・出力）", /\/cli\//],
  ["画面の共通（部品・処理）", /\/web\//],
  ["型と判定の共通（shared）", /\/shared\//],
];
/** 入口・kit はパッケージで、ほかは src の中のパス（/core/... の形。パッケージ名の tasks は照らさない）で決める */
const featureOf = (rel) => {
  const inner = rel.startsWith("packages/p3/") || rel.startsWith("packages/kit/") ? rel : `/${rel.replace(/^packages\/[^/]+\/src\//, "")}`;
  return FEATURES.find(([, re]) => re.test(inner))?.[0] ?? "未分類";
};

const EXT = /\.(ts|tsx|mjs)$/;
// 数えるのは src・bin・test の中だけ（ビルドの出力 lib・dist・build-src はその外）。node_modules と、コンテナの中で動く描画のスクリプトは除く
const skipDir = (p) => p.endsWith("/node_modules") || p.endsWith("/core/preflight/render-image");
function walk(dir) {
  let out = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!skipDir(p.split("\\").join("/"))) out = out.concat(walk(p));
    } else if (EXT.test(name) && !name.endsWith(".gen.ts")) out.push(p);
  }
  return out;
}

const count = (file) => {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const n = text.endsWith("\n") ? lines.length - 1 : lines.length;
  const comments = lines.filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l)).length;
  return { lines: n, comments };
};

const add = (map, key, c) => {
  const v = (map[key] ??= { files: 0, lines: 0, comments: 0 });
  v.files++;
  v.lines += c.lines;
  v.comments += c.comments;
};

const product = { total: { files: 0, lines: 0, comments: 0 }, packages: {}, layers: {}, features: {} };
for (const dir of readdirSync(join(root, "packages"))) {
  for (const sub of ["src", "bin"]) {
    for (const file of walk(join(root, "packages", dir, sub))) {
      const rel = relative(root, file).split("\\").join("/");
      const c = count(file);
      product.total.files++;
      product.total.lines += c.lines;
      product.total.comments += c.comments;
      add(product.packages, dir, c);
      const layer = /^packages\/[^/]+\/src\/([^/]+)\//.exec(rel)?.[1] ?? (sub === "bin" ? "bin" : "(src の直下)");
      add(product.layers, `${dir}/${layer}`, c);
      add(product.features, featureOf(rel), c);
    }
  }
}
const tests = { total: { files: 0, lines: 0, comments: 0 }, kinds: {}, features: {} };
for (const file of walk(join(root, "test"))) {
  const rel = relative(root, file).split("\\").join("/");
  const c = count(file);
  tests.total.files++;
  tests.total.lines += c.lines;
  tests.total.comments += c.comments;
  add(tests.kinds, rel.startsWith("test/ui/") ? "UI テスト（test/ui）" : rel.startsWith("test/fixtures/") ? "テストの資材（test/fixtures）" : "ユニットテスト", c);
  add(tests.features, featureOf(`/${rel.replace(/^test\//, "")}`), c);
}

const result = { root, product, tests };
if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const table = (title, map) => {
    const rows = Object.entries(map).sort((a, b) => b[1].lines - a[1].lines);
    console.log(`\n${title}`);
    for (const [k, v] of rows) console.log(`  ${String(v.lines).padStart(7)} 行  ${String(v.files).padStart(4)} ファイル  ${k}`);
  };
  console.log(`製品のコード: ${product.total.lines} 行（${product.total.files} ファイル、コメント ${product.total.comments} 行）`);
  table("パッケージ別", product.packages);
  table("パッケージと層", product.layers);
  table("機能別", product.features);
  console.log(`\nテスト: ${tests.total.lines} 行（${tests.total.files} ファイル）`);
  table("テストの区分", tests.kinds);
  table("テストの機能別（ファイル名で分ける）", tests.features);
}
