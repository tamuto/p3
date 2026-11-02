import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../store/fsutil.ts";
import type { PreflightLogEntry } from "../../shared/types.ts";
import { RENDER_LIMITS, RenderError, renderHtml, type RenderJob, type RenderOptions } from "./render.ts";
import { safeRelative, UI_DIR, UI_INDEX } from "./uiMaterials.ts";

export type Renderer = typeof renderHtml;
type Log = (e: Omit<PreflightLogEntry, "at">) => void;

/**
 * エンジンが書いた原稿（ui/index.json の items の html）を P3 が PNG にし、一覧に結果を書き足す:
 *   描けた: file（ui/ からの相対）と rendered（P3 が描いた。エンジンは画像を見ていない）
 *   描けない: renderError（理由）。取り込むときに「画像がありません」として不足に数える
 * 既に file があるもの・原稿の無いものは触らない。一覧が無い・読めないときは何もしない（取り込みで理由を残す）。
 * 描画の失敗・取消は例外にしない（評価は残す）
 */
export async function renderManuscripts(runDir: string, opts: RenderOptions & { log: Log; render?: Renderer }): Promise<void> {
  const uiDir = join(runDir, UI_DIR);
  const indexFile = join(uiDir, UI_INDEX);
  let index: { items?: unknown };
  try {
    if ((await lstat(uiDir)).isSymbolicLink() || (await lstat(indexFile)).isSymbolicLink()) return;
    index = JSON.parse(await readFile(indexFile, "utf8"));
  } catch {
    return;
  }
  if (!index || typeof index !== "object" || !Array.isArray(index.items)) return;
  const items = index.items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  // 「P3 が描いた」は P3 だけが書く（エンジンが書いたものは消す）
  let forged = false;
  for (const item of items) {
    if (!("rendered" in item)) continue;
    forged = true;
    delete item.rendered;
  }
  const jobs: RenderJob[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    if (item.file !== undefined || item.html === undefined) continue;
    const id = String(item.id ?? "");
    const html = safeRelative(item.html);
    if (!html || !/\.html?$/i.test(html)) {
      item.renderError = `原稿が ui/ の中の HTML ではありません: ${String(item.html)}`;
      continue;
    }
    const st = await lstat(join(uiDir, html)).catch(() => undefined);
    if (!st?.isFile() || st.size > RENDER_LIMITS.htmlBytes) {
      item.renderError = !st ? `原稿がありません: ${html}` : st.isSymbolicLink() ? "原稿がシンボリックリンクです" : `原稿が読めません: ${html}`;
      continue;
    }
    if (byId.has(id) || jobs.length >= RENDER_LIMITS.pages) {
      item.renderError = byId.has(id) ? "id が重なっています" : `描画できるのは ${RENDER_LIMITS.pages} 枚までです`;
      continue;
    }
    const viewport = Number(item.viewport);
    jobs.push({ id, html: await readFile(join(uiDir, html), "utf8"), width: Number.isInteger(viewport) ? viewport : 1280 });
    byId.set(id, item);
  }
  if (jobs.length) {
    opts.log({ kind: "info", text: `画面イメージを描画します（${jobs.length} 枚。評価の後に P3 が描きます）` });
    try {
      const results = await (opts.render ?? renderHtml)(jobs, uiDir, uiDir, opts);
      for (const r of results) {
        const item = byId.get(r.id)!;
        if (r.ok) {
          item.file = `${r.id}.png`;
          item.rendered = { by: "p3", clipped: !!r.clipped, blocked: r.blocked.length };
          delete item.renderError;
          if (r.blocked.length) opts.log({ kind: "info", text: `${r.id}: 読み込みを ${r.blocked.length} 件止めました` });
        } else {
          const error = r.error ?? "描画できませんでした";
          item.renderError = error;
          opts.log({ kind: "error", text: `${r.id} を描画できません: ${error}` });
        }
      }
    } catch (e) {
      const message = e instanceof RenderError ? e.message : `描画できません: ${(e as Error).message}`;
      opts.log({ kind: "error", text: `画面イメージを描画できません: ${message}` });
      for (const item of byId.values()) item.renderError = message;
    }
  }
  if (forged || jobs.length || items.some((x) => x.renderError)) await writeFileAtomic(indexFile, JSON.stringify(index, null, 2) + "\n");
}
