import { CodexImageError, updateCodexImage, type ImageUpdate } from "../server/preflight/codexImage.ts";
import { UsageError } from "./project.ts";

/**
 * p3 codex update。Codex を動かすイメージを今すぐ作り直し、入った Codex の版を表示する。
 * プロジェクトを決める前に動く（このマシンの Docker のもの。プロジェクト・認証・個人設定の自動更新の停止に関係しない）。
 * 進み具合は stderr に出し、--json の stdout は結果だけにする。
 */
export async function codexCommand(args: string[], docker = "docker"): Promise<{ data: unknown; text: string; code?: number }> {
  const [sub] = args;
  if (sub !== "update") throw new UsageError("p3 codex update（Codex のイメージを今すぐ作り直して、最新の Codex を入れる）");
  let r: ImageUpdate;
  try {
    r = await updateCodexImage({ docker, onProgress: (t) => process.stderr.write(`${t}\n`) });
  } catch (e) {
    if (!(e instanceof CodexImageError)) throw e;
    return {
      data: { ok: false, step: e.step, error: e.message, detail: e.detail ?? null },
      text: `更新できませんでした: ${e.message}${e.detail ? `\n  ${e.detail}` : ""}`,
      code: 1,
    };
  }
  const change = r.previous && r.previous !== r.version ? `（${r.previous} から）` : r.previous ? "（変わらず。これが最新）" : "";
  return {
    data: { ok: true, ...r },
    text: `Codex を更新しました: ${r.version}${change}\n  イメージ ${r.image}${r.createdAt ? `（${r.createdAt.slice(0, 19).replace("T", " ")} 作成）` : ""}`,
  };
}
