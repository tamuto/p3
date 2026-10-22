#!/usr/bin/env node
// p3 CLI の起動口。配布物（npm・Docker）はビルド済みの JavaScript（lib/。scripts/build-cli.mjs）で動かし、tsx・esbuild を使わない。
// ソースのあるチェックアウト（このリポジトリの開発）では、TypeScript のソースを tsx でそのまま動かす（ビルド不要）。
import { existsSync } from "node:fs";

// `pnpm --dir <p3 の場所> p3 ...` で別の場所から呼ばれたとき、pnpm はカレントを p3 の場所に移してしまう。
// 呼び出し元のカレント（INIT_CWD）に戻し、そこから対象のプロジェクト・今の要望（作業ツリー）・git のユーザーを判定する。
// p3 自身の package.json のスクリプトとして動いたときだけ（pnpx や、利用者のスクリプトから呼ばれたときは今の場所のまま）
if (
  process.env.npm_lifecycle_event === "p3" &&
  process.env.npm_package_name === "@infodb/p3" &&
  process.env.INIT_CWD
) {
  process.chdir(process.env.INIT_CWD);
}

if (existsSync(new URL("../src/cli/main.ts", import.meta.url))) {
  // 今いる場所（利用者のリポジトリ）の tsconfig.json を探しに行かない。P3 のソースは tsconfig が無くても同じに変換される
  const { register } = await import("tsx/esm/api");
  register({ tsconfig: false });
  await import("../src/cli/main.ts");
} else {
  await import("../lib/cli/main.js");
}
