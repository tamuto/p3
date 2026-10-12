import { Hono } from "hono";
import { z } from "zod";
import { THEMES, type Theme } from "../../shared/types.ts";
import { readTheme, writeTheme } from "../../core/userTheme.ts";
import { localOnly } from "./local.ts";

/**
 * /api/user-theme。個人設定のテーマだけを読み書きする（ほかの個人設定は返さない・変えない）。
 *   GET  → { theme }
 *   PUT  { theme } → { theme }。このマシンのローカルの画面からだけ（ChatGPT の接続と同じ確かめ方）
 */
export function userThemeRoutes(onChange: () => void = () => {}) {
  const app = new Hono();
  const input = z.object({ theme: z.enum(THEMES) }).strict();

  app.get("/", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ theme: await readTheme() });
  });

  app.put("/", async (c) => {
    const why = localOnly(c, true, "画面のテーマ");
    if (why) return c.json({ error: why }, 403);
    const parsed = input.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: `{ "theme": "${THEMES.join('" | "')}" } だけを送ってください` }, 400);
    const theme = await writeTheme(parsed.data.theme);
    onChange();
    return c.json({ theme });
  });
  return app;
}

/**
 * 最初の描画の前に読むスクリプト（index.html の先頭。GET /api/user-theme.js）。個人設定のテーマだけを埋め込み、
 * html 要素に data-theme・class "dark"・color-scheme を付ける。規則は web/lib/theme.ts の applyTheme と同じ。
 * 個人設定が読めなくても、画面は system で起動できるようにする（エラーはスクリプトの中のコメントに残す）。
 */
export function themeScript(theme: Theme, note?: string): string {
  return `${note ? `/* ${note.replace(/\*\//g, "* /")} */\n` : ""}(function (t) {
  var r = document.documentElement, m = false;
  try { m = window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) {}
  var d = t === "dark" || (t === "system" && m);
  r.dataset.theme = t;
  r.classList.toggle("dark", d);
  r.style.colorScheme = d ? "dark" : "light";
})(${JSON.stringify(theme)});
`;
}

export function userThemeScriptRoute() {
  const app = new Hono();
  app.get("/", async (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    c.header("cache-control", "no-store");
    try {
      return c.body(themeScript(await readTheme()));
    } catch (e) {
      return c.body(themeScript("system", `個人設定のテーマを読めませんでした: ${(e as Error).message}`));
    }
  });
  return app;
}
