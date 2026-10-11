import { Hono } from "hono";
import { z } from "zod";
import { THEMES } from "../../shared/types.ts";
import { readTheme, writeTheme } from "../userTheme.ts";
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
