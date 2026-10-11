#!/usr/bin/env node
// pcube CLI の起動口。TypeScript のソースを tsx でそのまま動かす（ビルド不要）。
import { register } from "tsx/esm/api";

// `pnpm --dir <p3 の場所> pcube ...` で別の場所から呼ばれたとき、pnpm はカレントを p3 の場所に移してしまう。
// 呼び出し元のカレント（INIT_CWD）に戻し、そこから対象のプロジェクト・今の要望（作業ツリー）・git のユーザーを判定する。
// p3 自身の package.json のスクリプトとして動いたときだけ（pnpx や、利用者のスクリプトから呼ばれたときは今の場所のまま）
if (
  ["pcube", "p3"].includes(process.env.npm_lifecycle_event ?? "") &&
  process.env.npm_package_name === "@infodb/p3" &&
  process.env.INIT_CWD
) {
  process.chdir(process.env.INIT_CWD);
}

// 今いる場所（利用者のリポジトリ）の tsconfig.json を探しに行かない。P3 のソースは tsconfig が無くても同じに変換される
register({ tsconfig: false });
await import("../src/cli/main.ts");
