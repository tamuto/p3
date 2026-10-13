import { Hono, type Context } from "hono";
import { z } from "zod";
import type { P3Context } from "../../core/context.ts";
import { GenerationRejected } from "../../core/releaseNotes/generate.ts";
import { exportReleaseNote, releaseNoteDetail, releaseOverview, saveReleaseNote, startGeneration } from "../../core/releaseNotes/service.ts";
import { ReleaseNoteError } from "../../core/releaseNotes/store.ts";

/**
 * リリースノート（画面のため）。規則と保存は core/releaseNotes（CLI の p3 release-notes と同じ）。
 *
 *   GET  /release-notes                     マイルストーンごとのノートの有無
 *   GET  /release-notes/:mid                保存したノートと材料（対象の要望・警告・出典）
 *   PUT  /release-notes/:mid                保存（version 無しは新規、ありは更新。違えば 409 rev_conflict）
 *   GET  /release-notes/:mid/export         保存した本文（Markdown のダウンロード）
 *   POST /release-notes/:mid/generate       要約の生成を始める（202。保存しない）
 *   GET  /release-notes/:mid/generations    このマイルストーンの生成（新しい順）
 *   GET  /release-generations/:id           生成1件 / POST .../cancel 取り消す
 */

const saveInput = z.object({
  body: z.string(),
  title: z.string().min(1).optional(),
  /** 本文の元にした材料の hash */
  basedOn: z.string().optional(),
  /** 読んだときの版（更新のときは必須）。無ければ新規 */
  version: z.string().optional(),
});

const actorOf = (c: Context) => c.req.header("x-p3-actor") ?? "human:web";

export function releaseNoteRoutes(ctx: P3Context) {
  const app = new Hono();

  app.onError(async (err, c) => {
    if (err instanceof ReleaseNoteError) {
      const mid = err.milestone;
      if (err.code === "not_found") return c.json({ error: err.message, code: "not_found" }, 404);
      if (err.code === "bad_id") return c.json({ error: err.message, code: "bad_id" }, 400);
      if (err.code === "invalid") return c.json({ error: err.message, code: "invalid" }, 422);
      // 版の競合・既にある: 今のノート（読めれば）を添える。画面は入力を残したまま見比べる
      const current = await ctx.ws.releaseNotes.read(mid).catch(() => null);
      return c.json({ error: err.message, code: "rev_conflict", reason: err.code, current }, 409);
    }
    if (err instanceof GenerationRejected) return c.json({ error: err.message, code: err.code }, err.code === "running" ? 409 : 400);
    if (err instanceof z.ZodError) return c.json({ error: "invalid input", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: err.message }, 400);
  });

  app.get("/release-notes", async (c) => c.json(await releaseOverview(ctx)));
  app.get("/release-notes/:mid", async (c) => c.json(await releaseNoteDetail(ctx, c.req.param("mid"))));
  app.put("/release-notes/:mid", async (c) => {
    const b = saveInput.parse(await c.req.json());
    return c.json(await saveReleaseNote(ctx, c.req.param("mid"), b, actorOf(c)));
  });
  app.get("/release-notes/:mid/export", async (c) => {
    const mid = c.req.param("mid");
    const body = await exportReleaseNote(ctx, mid);
    return c.body(body, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="release-notes-${mid}.md"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
  });
  app.post("/release-notes/:mid/generate", async (c) => {
    const { engine } = z.object({ engine: z.enum(["codex", "mock"]).optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await startGeneration(ctx, c.req.param("mid"), actorOf(c), engine), 202);
  });
  app.get("/release-notes/:mid/generations", (c) => c.json(ctx.releaseGenerator.list(c.req.param("mid"))));
  app.get("/release-generations/:id", (c) => {
    const g = ctx.releaseGenerator.get(c.req.param("id"));
    return g ? c.json(g) : c.json({ error: `生成がありません: ${c.req.param("id")}（serve を起動し直すと消えます）`, code: "not_found" }, 404);
  });
  app.post("/release-generations/:id/cancel", (c) => c.json({ cancelled: ctx.releaseGenerator.cancel(c.req.param("id")) }));

  return app;
}
