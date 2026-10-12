import type { Request, RequestStatus } from "../shared/types.ts";
import type { Workspace } from "./store/workspace.ts";

/**
 * 要望の「対応済」（resolved）の規則。CLI と API のどちらから変えても同じように効くよう、ここにまとめる。
 *
 *   - 対応済にできるのは、タスクが1件以上あり、全部が完了（status=done）で、読めないタスクファイルが無いときだけ。
 *     人の「済み」（checkedAt）・PR・マージは条件にしない。置き換えられたタスクも、残っていれば数える
 *   - 対応済の要望に未完了のタスクができたら（足した・完了から戻した・再評価でタスク化した）進行中に戻す
 *   - 最後のタスクを完了にしても自動では対応済にしない（作業を終えた側が明示的に設定する）
 */

export class StatusRuleError extends Error {}

/** 対応済にできないなら理由（できるなら undefined）。判定の直前にディスクから読み直す */
export async function resolveBlocker(ws: Workspace, rid: string): Promise<string | undefined> {
  const col = ws.tasksOf(rid);
  await col.load();
  const broken = [...col.errors.keys()];
  if (broken.length) return `読めないタスクファイルがあります: ${broken.join(", ")}（直してから対応済にしてください）`;
  const tasks = col.list();
  if (!tasks.length) return "タスクがありません（タスクの無い要望は対応済にできません）";
  const open = tasks.filter((t) => t.status !== "done");
  if (open.length) return `完了していないタスクがあります: ${open.map((t) => `${t.id}(${t.status})`).join(", ")}（完了させるか、不要ならアーカイブしてから対応済にしてください）`;
  return undefined;
}

/** ステータスを対応済に変えるなら規則を確かめる（満たさなければ何も書かずに失敗する） */
export async function checkStatusChange(ws: Workspace, rid: string, next: RequestStatus | undefined): Promise<void> {
  if (next !== "resolved") return;
  const why = await resolveBlocker(ws, rid);
  if (why) throw new StatusRuleError(`${rid} を対応済にできません: ${why}`);
}

/** 対応済なのに未完了のタスクがある（外部の直接編集など）。画面と CLI で知らせる */
export function resolvedIssue(ws: Workspace, r: Request): string | undefined {
  if (r.status !== "resolved") return undefined;
  const open = ws.tasksOf(r.id).list().filter((t) => t.status !== "done");
  return open.length
    ? `対応済ですが、完了していないタスクがあります: ${open.map((t) => t.id).join(", ")}（進行中に戻すには status=active）`
    : undefined;
}

/**
 * タスクを変えた後に呼ぶ: 対応済の要望に未完了のタスクがあれば進行中に戻す。戻したら true。
 * タスクの変更は済んでいるので、要望の更新に失敗したら、そう分かるエラーにする（再試行は request set status=active）。
 */
export async function reopenIfNeeded(ws: Workspace, rid: string, actor?: string): Promise<boolean> {
  const r = ws.requests.get(rid);
  if (!r || r.status !== "resolved") return false;
  if (!ws.tasksOf(rid).list().some((t) => t.status !== "done")) return false;
  try {
    await ws.requests.update(rid, { status: "active" }, { actor });
    return true;
  } catch (e) {
    throw new Error(`タスクは更新しましたが、要望 ${rid} を進行中に戻せませんでした: ${(e as Error).message}（p3 request set ${rid} status=active で直してください）`);
  }
}
