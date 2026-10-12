import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { MachineSettings } from "../core/machineSettings.ts";
import { ensureRenderImage, RenderError, renderHtml } from "../core/preflight/render.ts";
import { UsageError } from "./project.ts";

const USAGE = [
  "p3 render <原稿.html> [--out 画像.png] [--width 1280]   自己完結した HTML / CSS を PNG にする（Docker が要る）",
  "p3 render update                                       描画のイメージを今すぐ作り直す",
].join("\n");

/**
 * p3 render。Preflight の画面イメージと同じ描画（専用のコンテナ。ネットワークなし）で、手元の HTML を PNG にする。
 * プロジェクトを決める前に動く。DevContainer の中から使うときは、原稿の隣に作る一時のフォルダにもパスの対応（codex.pathMap）が効く
 */
export async function renderCommand(
  args: string[],
  o: { out?: string; width?: string },
  settings: Pick<MachineSettings, "codex">,
  cwd = process.cwd(),
): Promise<{ data: unknown; text: string; code?: number }> {
  const [sub] = args;
  const progress = (t: string) => process.stderr.write(`${t}\n`);
  try {
    if (sub === "update") {
      const { image } = await ensureRenderImage({ force: true, onProgress: progress });
      return { data: { ok: true, image }, text: `描画のイメージを作り直しました: ${image}` };
    }
    if (!sub || args.length > 1) throw new UsageError(USAGE);
    const src = resolve(cwd, sub);
    const html = await readFile(src, "utf8").catch(() => {
      throw new UsageError(`原稿が読めません: ${sub}`);
    });
    const out = resolve(cwd, o.out ?? join(dirname(src), `${basename(src, extname(src))}.png`));
    const width = o.width === undefined ? 1280 : Number(o.width);
    const [r] = await renderHtml([{ id: "page", html, width }], dirname(out), join(dirname(out), `.p3-render-out-${process.pid}`), {
      pathMap: settings.codex.pathMap,
      onProgress: progress,
    }).then(async (rs) => {
      // 一時の出力から、指定の名前に移す
      const { rename, rm } = await import("node:fs/promises");
      const tmp = join(dirname(out), `.p3-render-out-${process.pid}`);
      try {
        if (rs[0].ok) await rename(rs[0].file!, out);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      return rs;
    });
    if (!r.ok) return { data: { ok: false, error: r.error, blocked: r.blocked }, text: `描画できません: ${r.error}`, code: 1 };
    const notes = [
      r.clipped ? "  縦に長すぎるので上から切りました" : "",
      r.blocked.length ? `  止めた読み込み: ${r.blocked.join(", ")}` : "",
    ].filter(Boolean);
    return { data: { ok: true, file: out, clipped: r.clipped, blocked: r.blocked }, text: [`描画しました: ${out}`, ...notes].join("\n") };
  } catch (e) {
    if (!(e instanceof RenderError)) throw e;
    return { data: { ok: false, step: e.step, error: e.message }, text: `描画できません: ${e.message}`, code: 1 };
  }
}
