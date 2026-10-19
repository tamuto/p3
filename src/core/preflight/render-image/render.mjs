// 原稿（/in/jobs.json と HTML）を PNG（/out/<id>.png）にする。結果は stdout に JSON で1行。
//
// スクリプトは動かさない（javaScriptEnabled: false）。ページの読み込みは setContent で行い、file:// で開かない。
// http(s) などの読み込みは全部止めて記録する（コンテナにネットワークは無いので、これは二重の囲い）。
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// フォントを指定していない原稿も、ゴシック体（sans-serif）で描く（Chromium の既定は Times New Roman で、欧文が明朝系になる）。
// 原稿の先頭（doctype の後）に置き、詳細度 0 にするので、原稿のどの指定よりも弱い
const BASE_STYLE = "<style>:where(html){font-family:sans-serif}</style>";
const DOCTYPE = /^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i;
const withBaseStyle = (html) => {
  const m = DOCTYPE.exec(html);
  return m ? m[0] + BASE_STYLE + html.slice(m[0].length) : BASE_STYLE + html;
};

const MAX_HEIGHT = Number(process.env.P3_RENDER_MAX_HEIGHT ?? 16384);
const PAGE_TIMEOUT = Number(process.env.P3_RENDER_PAGE_TIMEOUT ?? 20000);

const jobs = JSON.parse(await readFile("/in/jobs.json", "utf8"));
const browser = await chromium.launch();
const results = [];
try {
  for (const job of jobs) {
    const blocked = [];
    const context = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      serviceWorkers: "block",
      viewport: { width: job.width, height: 800 },
      deviceScaleFactor: 1,
      locale: "ja-JP",
    });
    try {
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("data:")) return route.continue();
        blocked.push(url.slice(0, 200));
        return route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(PAGE_TIMEOUT);
      await page.setContent(withBaseStyle(await readFile(`/in/${job.file}`, "utf8")), { waitUntil: "load", timeout: PAGE_TIMEOUT });
      const path = `/out/${job.id}.png`;
      await page.screenshot({ path, fullPage: true, animations: "disabled", timeout: PAGE_TIMEOUT });
      // 縦に長すぎるときは上から切る
      const height = (await readFile(path)).readUInt32BE(20);
      const clipped = height > MAX_HEIGHT;
      if (clipped) {
        await page.screenshot({ path, fullPage: true, clip: { x: 0, y: 0, width: job.width, height: MAX_HEIGHT }, animations: "disabled", timeout: PAGE_TIMEOUT });
      }
      results.push({ id: job.id, ok: true, clipped, blocked });
    } catch (e) {
      results.push({ id: job.id, ok: false, error: String(e?.message ?? e).split("\n")[0], blocked });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
process.stdout.write(JSON.stringify({ results }) + "\n");
