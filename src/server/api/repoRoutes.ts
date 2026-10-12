import { Hono } from "hono";
import { z } from "zod";
import type { PcubeContext } from "../context.ts";
import { addRepo, checkFolder, removeRepo, setLocalRepoPath, updateRepo } from "../repoAdmin.ts";
import { localOnly } from "./local.ts";

const mapEntry = z.object({ path: z.string(), role: z.string(), entry: z.string().optional() });
const repoPatch = z
  .object({ role: z.string(), readFirst: z.boolean(), writable: z.boolean(), mapFile: z.string().nullable(), map: z.array(mapEntry) })
  .partial();

/**
 * /api/repos: 参照先（設定画面）。共有の定義の追加・変更・削除はプロジェクトの設定と同じく画面から行える。
 * このマシンのパス（個人設定）は、P3 を動かしているマシンのローカルの画面からだけ見せ・変える（ほかのマシンに個人のパスを見せない）
 */
export function repoRoutes(ctx: PcubeContext) {
  const { ws } = ctx;
  const app = new Hono();

  app.get("/", (c) => {
    const local = !localOnly(c, false, "このマシンのパス");
    return c.json({
      local,
      registered: !!ctx.projectName,
      repos: ws.refs().map((r) => ({
        name: r.name,
        role: r.role,
        readFirst: r.readFirst,
        writable: r.writable,
        map: r.map,
        mapFile: r.mapFile ?? null,
        mount: r.mount,
        status: r.status,
        ...(local ? { local: r.local ?? null, reason: r.reason ?? null } : {}),
      })),
    });
  });
  app.post("/", async (c) => {
    const b = repoPatch.extend({ name: z.string(), path: z.string().optional() }).parse(await c.req.json());
    if (b.path) {
      const why = localOnly(c, true, "このマシンのパスの登録");
      if (why) return c.json({ error: why }, 403);
    }
    const { name, path, mapFile, ...patch } = b;
    // パスを先に確かめる（共有の定義だけ書いて失敗しないように）
    if (path) checkFolder(path);
    const entry = await addRepo(ws, name, { ...patch, mapFile: mapFile ?? undefined });
    if (path) await setLocalRepoPath(ws, ctx.projectName, name, path);
    return c.json(entry, 201);
  });
  app.patch("/:name", async (c) => {
    const { mapFile, ...patch } = repoPatch.parse(await c.req.json());
    return c.json(await updateRepo(ws, c.req.param("name"), { ...patch, ...(mapFile !== undefined ? { mapFile: mapFile ?? undefined } : {}) }));
  });
  app.delete("/:name", async (c) => {
    await removeRepo(ws, ctx.projectName, c.req.param("name"));
    return c.json({ ok: true });
  });
  for (const method of ["put", "delete"] as const) {
    app[method]("/:name/path", async (c) => {
      const why = localOnly(c, true, "このマシンのパスの登録");
      if (why) return c.json({ error: why }, 403);
      const path = method === "put" ? z.object({ path: z.string().min(1) }).parse(await c.req.json()).path : null;
      await setLocalRepoPath(ws, ctx.projectName, c.req.param("name"), path);
      return c.json({ ok: true });
    });
  }
  return app;
}
