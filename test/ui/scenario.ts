// UI テストの1つのシナリオ: 一時の環境・p3 serve・ブラウザを起こし、手順ごとに失敗の説明（シナリオ・手順・対象・サーバのログ・画面の画像）を付け、
// 成功・失敗・時間切れのどれでも、ブラウザとサーバを止めてから一時のデータを消す。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { expect, inject } from "vitest";
import { makeUiEnv, startServe, type Serve, type UiEnv } from "./env.ts";

/** UI テストの操作・待ちの上限（固定の sleep はしない） */
export const UI_TIMEOUT = 15_000;

export interface Scenario {
  env: UiEnv;
  serve: Serve;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** 手順。失敗したら、どのシナリオのどの手順か・画面の画像の場所・サーバのログの末尾を付けて投げ直す（画像は on の画面。既定は page） */
  step: <T>(name: string, fn: () => Promise<T>, on?: Page) => Promise<T>;
  /** 幅とテーマを変えた別の画面（同じサーバ。閉じるのは close でまとめて） */
  open: (o: { width: number; height?: number; colorScheme?: "light" | "dark" }) => Promise<Page>;
  close: () => Promise<void>;
}

export async function openScenario(
  name: string,
  opts: { viewport?: { width: number; height: number }; prepare?: (env: UiEnv) => Promise<void> } = {},
): Promise<Scenario> {
  const env = await makeUiEnv();
  let serve: Serve | undefined;
  let browser: Browser | undefined;
  try {
    // 画面の操作の対象ではない状態は、サーバを起こす前に CLI で用意する
    await opts.prepare?.(env);
    serve = await startServe(env);
    // ブラウザは親の環境で起こす（一時の HOME をブラウザの探索に使わない）。日本語のフォントがあれば Noto Sans CJK JP で描く
    const fontconfig = inject("fontconfig");
    browser = await chromium.launch(fontconfig ? { env: { ...process.env, FONTCONFIG_FILE: fontconfig } } : {});
    const context = await browser.newContext({ baseURL: serve.url, viewport: opts.viewport ?? { width: 1280, height: 900 }, colorScheme: "light", locale: "ja-JP" });
    context.setDefaultTimeout(UI_TIMEOUT);
    context.setDefaultNavigationTimeout(UI_TIMEOUT);
    const page = await context.newPage();
    const s = serve;
    const b = browser;
    const scenario: Scenario = {
      env,
      serve: s,
      browser: b,
      context,
      page,
      async step(stepName, fn, on = page) {
        try {
          return await fn();
        } catch (e) {
          throw new Error(await describeFailure(name, stepName, e, on, s), { cause: e });
        }
      },
      async open(o) {
        const c = await b.newContext({ baseURL: s.url, viewport: { width: o.width, height: o.height ?? 800 }, colorScheme: o.colorScheme ?? "light", locale: "ja-JP" });
        c.setDefaultTimeout(UI_TIMEOUT);
        c.setDefaultNavigationTimeout(UI_TIMEOUT);
        return c.newPage();
      },
      async close() {
        await b.close().catch(() => {});
        await s.stop();
        await env.cleanup();
      },
    };
    return scenario;
  } catch (e) {
    await browser?.close().catch(() => {});
    await serve?.stop();
    await env.cleanup();
    throw e;
  }
}

async function describeFailure(name: string, stepName: string, e: unknown, page: Page, serve: Serve): Promise<string> {
  const msg = e instanceof Error ? e.message : String(e);
  // 画面の画像は一時の環境の外に残す（中身は一時のデータだけ。個人の設定・プロジェクトは含まない）
  let shot = "（撮れませんでした）";
  try {
    const dir = await mkdtemp(join(tmpdir(), "p3-ui-failed-"));
    const path = join(dir, "page.png");
    await page.screenshot({ path, fullPage: true, timeout: 5000 });
    shot = path;
  } catch {
    // 画面が閉じているなど
  }
  const log = serve.log().trim().split("\n").slice(-20).join("\n");
  return [
    `UI テスト「${name}」の手順「${stepName}」で失敗しました: ${msg.split("\n")[0]}`,
    ...msg.split("\n").slice(1, 12).map((l) => `  ${l}`),
    `  その時の URL: ${page.url()}`,
    `  その時の画面: ${shot}`,
    `  p3 serve のログ（末尾）:`,
    ...log.split("\n").map((l) => `    ${l}`),
  ].join("\n");
}

// 状態を待つ照合（playwright-core には待つ expect が無いので、vitest の expect.poll で上限まで待つ）
const opts = { timeout: UI_TIMEOUT, interval: 100 };

export const until = {
  visible: (l: Locator, timeout = UI_TIMEOUT) => l.waitFor({ state: "visible", timeout }),
  async text(l: Locator, want: string | RegExp) {
    if (typeof want === "string") await expect.poll(() => l.innerText(), opts).toBe(want);
    else await expect.poll(() => l.innerText(), opts).toMatch(want);
  },
  async count(l: Locator, n: number) {
    await expect.poll(() => l.count(), opts).toBe(n);
  },
  async value(l: Locator, v: string) {
    await expect.poll(() => l.inputValue(), opts).toBe(v);
  },
  async enabled(l: Locator) {
    await expect.poll(() => l.isEnabled(), opts).toBe(true);
  },
  async disabled(l: Locator) {
    await expect.poll(() => l.isDisabled(), opts).toBe(true);
  },
  async url(page: Page, re: RegExp) {
    await expect.poll(() => page.url(), opts).toMatch(re);
  },
};
