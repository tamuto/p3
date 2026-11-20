/**
 * 動いている p3 の版（Codex に名乗る clientInfo など）。配布の単位（npm の @infodb/p3）の版は入口が知っているので、入口が起動のときに渡す。
 * 製品（tasks など）は自分の package.json を探さずにここを読む（複数パッケージの構成では kit。docs/architecture.md「パッケージの構成」）
 */
let version = "0.0.0";

/** 入口が起動のときに一度だけ呼ぶ */
export function setAppVersion(v: string): void {
  version = v;
}

/** 渡されていなければ 0.0.0（テストで部品を直接作ったときなど） */
export function appVersion(): string {
  return version;
}
