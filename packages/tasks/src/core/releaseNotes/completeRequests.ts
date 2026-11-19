import type { ReleaseMaterial, RequestCompletionPlan, RequestCompletionResult } from "../../shared/types.ts";
import type { P3Context } from "../context.ts";
import { updateRequest } from "../requestOps.ts";
import { hierarchyNow, resolveBlocker } from "../requestStatus.ts";
import { ConflictError } from "../store/collection.ts";
import { Workspace } from "../store/workspace.ts";
import { materialOf } from "./material.ts";
import { checkMilestoneId, ReleaseNoteError } from "./store.ts";

/**
 * マイルストーンの要望を一括で完了済にする。規則はここだけに置く（CLI・API・画面は判定を見せて、表示したときの材料の hash で頼むだけ）。
 *
 *   - 判定は材料（material.ts の収録の条件）と同じ: 見送りを除く全要望が収録できる（対応済か完了済・タスクが1件以上で全部完了・
 *     読めないタスクなし）ときだけできる。マイルストーンが project.yaml に無い・所属の分からない読めない要望があればできない
 *   - 変えるのは対応済（resolved）の要望のステータスだけ（→ done）。完了済・見送り・アーカイブした要望、タスク（状態・済み）、
 *     マイルストーン、ノートは変えない。変更の記録が無い・ノートを保存していない・済みが無いことは条件にしない
 *   - 実行はディスクから読み直した材料で判定し直し、表示したときの hash と違えば何も書かない（material_changed）。できなければ
 *     何も書かない（blocked）
 *   - 子のある要望は配下が終わっているときだけ（material.ts）。子から親の順に書く
 *   - 複数のファイルをまとめて書く仕組みは無いので、1件ずつ書く。書く直前に、タスクを読み直して確かめ、要望は判定したときの rev で
 *     書く（違えば競合）。途中で失敗したら止め、完了済にしたもの・失敗した1件・まだ変えていないものを返す（戻さない。外の変更を
 *     上書きしないため）。やり直しは、取り直した判定でもう一度頼む（完了済にしたものは対象から外れ、書き直さない）
 */

/** 材料から判定する（書かない） */
export function completionPlanOf(material: ReleaseMaterial): RequestCompletionPlan {
  const plan: RequestCompletionPlan = { milestone: material.milestone.id, basedOn: material.hash, ready: false, targets: [], alreadyDone: [], skipped: [], blockers: [] };
  if (!material.milestone.known) plan.blockers.push({ target: material.milestone.id, reason: `マイルストーン ${material.milestone.id} は project.yaml にありません` });
  for (const w of material.warnings.filter((x) => x.code === "broken_request")) plan.blockers.push({ target: w.target, reason: w.message });
  for (const r of material.requests) {
    if (r.status === "rejected") plan.skipped.push(r.id);
    else if (!r.included) {
      const open = r.tasks.filter((t) => t.status !== "done").map((t) => `${t.id}(${t.status})`);
      const detail = r.reason === "完了していないタスクがある" && open.length ? `: ${open.join(", ")}` : "";
      plan.blockers.push({ target: r.id, reason: `${r.title}（${r.id}）: ${r.reason ?? "収録できません"}${detail}` });
    }
    else if (r.status === "resolved") plan.targets.push({ id: r.id, title: r.title });
    else plan.alreadyDone.push(r.id);
  }
  plan.ready = plan.blockers.length === 0;
  return plan;
}

/** 頼めない（何も書いていない）。material_changed: 表示したときの材料と違う / blocked: 未完了などがある。plan は今の判定 */
export class CompletionRejected extends Error {
  constructor(
    readonly code: "material_changed" | "blocked",
    message: string,
    readonly plan: RequestCompletionPlan,
  ) {
    super(message);
  }
}

/** 今の判定（ディスクから読み直す） */
export async function completionPlan(ctx: P3Context, mid: string): Promise<RequestCompletionPlan> {
  return (await snapshot(ctx, mid)).plan;
}

/** 一括で完了済にする。basedOn は判定を見せたときの材料の hash（必須） */
export async function completeMilestoneRequests(ctx: P3Context, mid: string, basedOn: string, actor?: string): Promise<RequestCompletionResult> {
  const { snap, plan } = await snapshot(ctx, mid);
  if (plan.basedOn !== basedOn) {
    throw new CompletionRejected("material_changed", "表示したあとで、このマイルストーンの要望・タスクが変わりました。何も変えていません。読み直して確かめてから、もう一度実行してください", plan);
  }
  if (!plan.ready) {
    throw new CompletionRejected("blocked", `完了済にできません（何も変えていません）: ${plan.blockers.map((b) => b.reason).join(" / ")}`, plan);
  }
  const result: RequestCompletionResult = { milestone: mid, completed: [], notRun: [], alreadyDone: plan.alreadyDone };
  // 子から親の順（深いものから）。親を完了済にする判定が、先に完了済にした子を見る
  const h = hierarchyNow(snap);
  const depth = (id: string) => h.ancestors(id).length;
  const targets = [...plan.targets].sort((a, b) => depth(b.id) - depth(a.id));
  for (const [i, t] of targets.entries()) {
    try {
      // タスクの変更は要望の rev に出ないので、書く直前に読み直して確かめる。要望（所属・状態）は判定したときの rev で確かめる
      const why = await resolveBlocker(ctx.ws, t.id);
      if (why) {
        result.failed = { id: t.id, reason: why, code: "changed" };
      } else {
        await updateRequest(ctx, t.id, { status: "done" }, { expectedRev: snap.requests.require(t.id).rev, actor });
        result.completed.push(t);
        continue;
      }
    } catch (e) {
      result.failed =
        e instanceof ConflictError
          ? { id: t.id, reason: `判定したあとで要望が変わりました（${(e as Error).message}）`, code: "conflict" }
          : { id: t.id, reason: (e as Error).message, code: "error" };
    }
    result.notRun = targets.slice(i + 1).map((x) => x.id);
    break;
  }
  return result;
}

/** ディスクから読み直した状態で、材料と判定を作る。project.yaml に無く、ノートも無いマイルストーンは not_found */
async function snapshot(ctx: P3Context, mid: string) {
  checkMilestoneId(mid);
  const snap = new Workspace(ctx.ws.dataDir);
  await snap.load();
  const material = materialOf(snap, mid);
  if (!material.milestone.known && !(await ctx.ws.releaseNotes.ids()).includes(mid)) {
    throw new ReleaseNoteError("not_found", mid, `マイルストーンがありません: ${mid}`);
  }
  return { snap, material, plan: completionPlanOf(material) };
}
