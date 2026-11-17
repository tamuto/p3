// UI テストのブラウザ（Playwright の Chromium headless shell）が使えるかを決める。
//
// Playwright が実際に起動するもの（既定のキャッシュ・PLAYWRIGHT_BROWSERS_PATH）で一度起動してみて、
// 実行ファイルが無いときだけ「飛ばす」にする。実行ファイルがあるのに起動できない（共有ライブラリが無いなど）ときは失敗にする。
// 自動でダウンロードはしない。pnpm check は最初（型検査の前）に checkBrowser で確かめ、使えなければ入れ方を出して止める
// （scripts/check-browser.ts。コンテナを作り直して消えたことに、単体テストとビルドを待たずに気づくため）。
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";

export const INSTALL_HINT = "pnpm exec playwright-core install chromium-headless-shell";
export const DEPS_HINT = "pnpm exec playwright-core install-deps chromium-headless-shell";

export type ChromiumProbe = { available: true } | { available: false; reason: string };

/** 実行ファイルが無いことによる起動の失敗なら、そのパス（Playwright の文言のパスが本当に無いことも確かめる） */
export function missingExecutable(e: unknown, exists: (path: string) => boolean = existsSync): string | undefined {
  const m = e instanceof Error ? /executable doesn't exist at (\S+)/i.exec(e.message) : null;
  return m && !exists(m[1]) ? m[1] : undefined;
}

/** 起動してみる。無ければ { available: false }、ほかの失敗は投げる */
export async function probeChromium(launch: () => Promise<Browser> = () => chromium.launch()): Promise<ChromiumProbe> {
  let browser: Browser;
  try {
    browser = await launch();
  } catch (e) {
    const path = missingExecutable(e);
    if (path) return { available: false, reason: `Chromium（headless shell）がありません: ${path}` };
    const first = e instanceof Error ? e.message.split("\n").slice(0, 8).join("\n") : String(e);
    throw new Error(`Chromium を起動できません（実行ファイルはあります。UI テストは飛ばしません）:\n${first}\n共有ライブラリが無いなら: ${DEPS_HINT}`, { cause: e });
  }
  await browser.close();
  return { available: true };
}

/** pnpm check の最初の確かめ: 使えなければ、理由と入れ方の文 */
export async function checkBrowser(launch?: () => Promise<Browser>): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const probe = await probeChromium(launch);
    if (probe.available) return { ok: true };
    return { ok: false, message: `UI テストのブラウザがありません。入れてから、もう一度 pnpm check を実行してください\n  ${probe.reason}\n  入れるには: ${INSTALL_HINT}` };
  } catch (e) {
    // Playwright の文言は起動のコマンド全体を含んで長いので、ブラウザが出したエラーの行（[err]）だけを残す
    const text = e instanceof Error && e.cause instanceof Error ? e.cause.message : e instanceof Error ? e.message : String(e);
    // 正規表現に制御文字を直接書かない（lint の no-control-regex）ため、端末の色の指定（ESC [ … m）は文字コードで外す
    const plain = text.replaceAll(new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, "g"), "");
    const errs = [...new Set(plain.split("\n").flatMap((l) => /\[err\]\s*(.+)$/.exec(l)?.[1]?.trim() ?? []))];
    const detail = errs.length > 0 ? errs : [text.split("\n")[0]];
    return {
      ok: false,
      message: ["UI テストのブラウザを起動できません（実行ファイルはあります）。直してから、もう一度 pnpm check を実行してください", ...detail, `共有ライブラリが無いなら: ${DEPS_HINT}`].join("\n  "),
    };
  }
}
