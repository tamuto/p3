import type { PreflightRun, RequestStatus } from "./types.ts";

/**
 * タスク化した後の要望は再評価しない（docs/architecture.md「Preflight」）。流れは Preflight → タスク化 → タスクの実行で、タスク化した後に
 * 変えたいことは新しい要望でやり直す。Preflight を始める処理（通常の実行・手元の評価の準備）と画面の操作が、この1か所で決める。
 *   - 進行中・対応済・完了済の要望は始めない
 *   - 状態を戻した（未着手に戻した・見送りにした）要望も、その要望自身をタスク化・分割の採用をした記録（実際に作ったタスク・子）があれば始めない。
 *     予約だけの記録（作る前に落ちた）は数えない。Preflight を通さずにタスクを足しただけの要望は始められる
 */
export const NEW_REQUEST_HINT = "変えたいことは新しい要望を登録してください";

const CLOSED: Partial<Record<RequestStatus, string>> = { active: "進行中", resolved: "対応済", done: "完了済" };

type RunRecord = Pick<PreflightRun, "id" | "materialized" | "materialization" | "adoption">;

/** 始められない理由（始められるなら undefined） */
export function preflightClosedReason(status: RequestStatus, runs: readonly RunRecord[]): string | undefined {
  if (CLOSED[status]) return `${CLOSED[status]}の要望は、タスク化した後なので再評価しません`;
  const done = runs.find((r) => r.materialized?.length || Object.keys(r.materialization?.created ?? {}).length || r.adoption?.created.length);
  if (done) return `${done.id} の${done.adoption ? "分割の採用" : "タスク化"}をした要望なので再評価しません`;
  return undefined;
}
