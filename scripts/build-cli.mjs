// 配布物を作る（pnpm build から呼ぶ。画面は先に vite build で packages/p3/dist/web に出しておく）。利用者の環境では tsx（と esbuild）を使わずに動かすため、
// 入口（packages/p3）・tasks・kit の Node で動く部分を 1 つのパッケージ @infodb/p3 の JavaScript にまとめる（kit・tasks は公開しない。同梱する）。
//   1. 一時のフォルダ（packages/p3/build-src）に、配布物と同じ並びでソースを集める:
//        入口の src/{cli,core,server} → cli・core・server、tasks の src/{cli,core,server,shared} → tasks/、kit の src → kit/
//      パッケージ名の import（@infodb/p3-tasks/... ・@infodb/p3-kit/...）は、集めた先への相対パスに書き換える
//   2. tsc で packages/p3/lib に 1:1 で出す（相対の import の .ts は .js に書き換わる）。.ts 以外の資材（描画のイメージ・Mock の画面・起動の補助・
//      guide.md）は同じ場所に写す。入口の lib/{cli,server} は src と同じ深さなので、import.meta.url からの相対の参照
//      （../../package.json・../../dist/web・skills）はそのまま効く。tasks の資材はそのファイルと同じフォルダだけを参照する
//   3. 公開する中身を dist/package に組み立てる: packages/p3 の bin・lib・dist/web と、リポジトリのルートの skills・docs・README.md・LICENSE。
//      manifest は packages/p3/package.json から開発だけの項目（devDependencies の workspace の参照・scripts）を外したもの
//      （npm pack ./dist/package・npm publish ./dist/package で出す。docs/publishing.md）
// 開発（このリポジトリの pnpm p3・テスト）はソースのまま動かす（packages/p3/bin/p3.mjs が src/cli/main.ts の有無で決める）
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "packages", "p3");
const staging = join(entry, "build-src");
const out = join(entry, "lib");
const pack = join(root, "dist", "package");

/** 集める元と先（先は staging からの相対） */
const SOURCES = [
  ...["cli", "core", "server"].map((l) => [join(entry, "src", l), l]),
  ...["cli", "core", "server", "shared"].map((l) => [join(root, "packages", "tasks", "src", l), join("tasks", l)]),
  [join(root, "packages", "kit", "src"), "kit"],
];
/** パッケージ名 → staging の中の置き場所 */
const NAMES = { "@infodb/p3-tasks": "tasks", "@infodb/p3-kit": "kit" };
const SPEC = /((?:^|\s)(?:import|export)\s[^"';]*?from\s*|import\s*\(\s*|^\s*import\s*)(["'])(@infodb\/p3-(?:tasks|kit))\/([^"']+)\2/gm;

const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)).map((f) => join(name, f)) : [name]));

rmSync(staging, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
let rewritten = 0;
for (const [from, to] of SOURCES) {
  for (const f of walk(from)) {
    const dest = join(staging, to, f);
    mkdirSync(dirname(dest), { recursive: true });
    if (!/\.(ts|mjs)$/.test(f)) {
      cpSync(join(from, f), dest);
      continue;
    }
    const text = readFileSync(join(from, f), "utf8").replace(SPEC, (_m, head, q, name, sub) => {
      rewritten++;
      const target = join(staging, NAMES[name], sub);
      const rel = relative(dirname(dest), target);
      return `${head}${q}${rel.startsWith(".") ? rel : `./${rel}`}${q}`;
    });
    writeFileSync(dest, text);
  }
}

// tsc（staging の中だけ。外の依存は packages/p3/node_modules から解く）
const tsconfig = join(staging, "tsconfig.json");
writeFileSync(
  tsconfig,
  JSON.stringify({
    extends: relative(staging, join(root, "tsconfig.build.json")),
    compilerOptions: { rootDir: ".", outDir: relative(staging, out) },
    include: ["."],
  }),
);
try {
  execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", tsconfig], { cwd: root, stdio: "inherit" });
} catch {
  process.exitCode = 1;
  throw new Error("tsc に失敗しました（packages/p3/build-src を確かめてください）");
}
let copied = 0;
for (const f of walk(staging)) {
  if (f.endsWith(".ts") || f === "tsconfig.json") continue;
  mkdirSync(dirname(join(out, f)), { recursive: true });
  cpSync(join(staging, f), join(out, f));
  copied++;
}
rmSync(staging, { recursive: true, force: true });
console.log(`packages/p3/lib/: 入口・tasks・kit の CLI・serve を JavaScript にしました（パッケージ名の import ${rewritten} 件を書き換え、資材 ${copied} 件を写しました）`);

// 公開する中身。画面（packages/p3/dist/web）は vite build で先に作る。--require-web（pnpm build）では無ければ止め、無いまま組み立てるのは
// テスト（test/pack.test.ts。pnpm -s check はテストの後に画面をビルドする）だけ
const web = existsSync(join(entry, "dist", "web", "index.html"));
if (!web && process.argv.includes("--require-web")) throw new Error("画面のビルド（packages/p3/dist/web）がありません。先に vite build を実行してください");
rmSync(pack, { recursive: true, force: true });
mkdirSync(pack, { recursive: true });
const manifest = JSON.parse(readFileSync(join(entry, "package.json"), "utf8"));
const { devDependencies: _dev, scripts: _scripts, ...published } = manifest;
writeFileSync(join(pack, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
for (const p of ["bin", "lib", ...(web ? ["dist/web"] : [])]) cpSync(join(entry, p), join(pack, p), { recursive: true });
for (const p of ["skills", "docs", "README.md", "LICENSE"]) cpSync(join(root, p), join(pack, p), { recursive: true });
console.log(`dist/package/: 公開する中身を組み立てました（${published.name}@${published.version}${web ? "" : "。画面のビルドなし"}。npm pack ./dist/package）`);
