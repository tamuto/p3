// UI テストのブラウザ（Playwright の Chromium headless shell）が使えるかを決める。
//
// Playwright が実際に起動するもの（既定のキャッシュ・PLAYWRIGHT_BROWSERS_PATH）で一度起動してみて、
// 実行ファイルが無いときだけ「飛ばす」にする。実行ファイルがあるのに起動できない（共有ライブラリが無いなど）ときは失敗にする。
// 自動でダウンロードはしない。
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";

export const INSTALL_HINT = "pnpm exec playwright-core install chromium-headless-shell";

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
    throw new Error(`Chromium を起動できません（実行ファイルはあります。UI テストは飛ばしません）:\n${first}`, { cause: e });
  }
  await browser.close();
  return { available: true };
}
