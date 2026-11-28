import { applyQualityOps, type QualityOp, type QualityState } from "../shared/quality.ts";
import type { Workspace } from "../../../core/store/workspace.ts";

/**
 * 品質基準の操作（CLI の p3 quality・API の /quality はここを呼ぶ）。規則は shared/quality.ts。
 * 書くのは project.yaml の quality だけで、書く直前にロックの中で読み直した最新の値に操作を当てる。コマンドの実行・依存の導入はしない
 */
export const qualityState = (ws: Workspace): QualityState => ws.project.quality ?? { state: "unset" };

/** 操作を当てて保存し、保存した後の状態を返す */
export async function updateQuality(ws: Workspace, ops: readonly QualityOp[]): Promise<QualityState> {
  await ws.writeQuality((cur) => applyQualityOps(cur.quality ?? { state: "unset" }, ops, { repoNames: cur.repos.map((r) => r.name) }));
  return qualityState(ws);
}
