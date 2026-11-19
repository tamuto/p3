import { diagnoseRequest, diagnoseTask, isReviewTarget, reviewSummary, type ReviewDiagnosis, type ReviewNow } from "../shared/reviewCandidate.ts";
import type { Request, RequestReviewCounts, Task } from "../../../shared/types.ts";
import type { P3Context } from "../../../core/context.ts";
import { hierarchyNow } from "../../../core/requestStatus.ts";

/**
 * 見直し候補の読み取り（規則は shared/reviewCandidate.ts）。読み込んだ値だけで診断し、ファイルは書かない・git も実行しない。
 * アーカイブした要望・タスクは見ない
 */

const nowOf = (ctx: P3Context): ReviewNow => ({ quality: ctx.ws.project.quality, qualityVersion: ctx.ws.project.qualityVersion });

/** タスクの診断（完了していなければ undefined） */
export function taskReview(ctx: P3Context, task: Task): ReviewDiagnosis | undefined {
  return diagnoseTask(task, ctx.ws.requests.get(task.request), nowOf(ctx));
}

/** 要望自身の診断（対応済・完了済でなければ undefined） */
export function requestSelfReview(ctx: P3Context, r: Request): ReviewDiagnosis | undefined {
  return diagnoseRequest(r, nowOf(ctx));
}

const isCandidate = (d: ReviewDiagnosis | undefined) => d?.state === "candidate";

/**
 * 1回の読み取り（進捗の計算など）の中で診断を使い回す入れ物。タスクは要望 ID を含む参照（ref）、要望自身は要望 ID で引く
 * （別の要望の同じタスク ID を混ぜない）。診断が無い（完了していない）ことも覚える。呼び出しをまたいでは持たない
 * （次の読み取りではその時点の条件で診断し直す）
 */
export interface ReviewMemo {
  task: (t: Task) => ReviewDiagnosis | undefined;
  request: (r: Request) => ReviewDiagnosis | undefined;
}

export function reviewMemo(ctx: P3Context): ReviewMemo {
  const now = nowOf(ctx);
  const tasks = new Map<string, ReviewDiagnosis | undefined>();
  const requests = new Map<string, ReviewDiagnosis | undefined>();
  return {
    task: (t) => {
      if (!tasks.has(t.ref)) tasks.set(t.ref, diagnoseTask(t, ctx.ws.requests.get(t.request), now));
      return tasks.get(t.ref);
    },
    request: (r) => {
      if (!requests.has(r.id)) requests.set(r.id, diagnoseRequest(r, now));
      return requests.get(r.id);
    },
  };
}

/**
 * 要望の概要（自身・自分のタスク・自分を除く配下）。配下は子孫の要望自身とそのタスクを1回ずつ数える。
 * memo を渡すと診断を使い回す（進捗は全部の要望で1つの memo を使う）
 */
export function requestReviewCounts(ctx: P3Context, r: Request, h = hierarchyNow(ctx.ws), memo = reviewMemo(ctx)): RequestReviewCounts {
  const self = memo.request(r);
  const tasksOf = (id: string) => ctx.ws.tasksOf(id).list().filter((t) => isCandidate(memo.task(t))).length;
  let below = 0;
  for (const d of h.descendants(r.id)) below += tasksOf(d.id) + (isCandidate(memo.request(d)) ? 1 : 0);
  return { ...(self ? { self: reviewSummary(self) } : {}), tasks: tasksOf(r.id), below };
}

/** 要望の詳細に添える診断（自身・タスクごとの概要・配下の件数） */
export function requestReview(ctx: P3Context, rid: string) {
  const r = ctx.ws.requests.require(rid);
  const self = requestSelfReview(ctx, r);
  const tasks = Object.fromEntries(
    ctx.ws
      .tasksOf(rid)
      .list()
      .flatMap((t) => {
        const d = taskReview(ctx, t);
        return d ? [[t.id, reviewSummary(d)]] : [];
      }),
  );
  return { ...(self ? { self } : {}), tasks, counts: requestReviewCounts(ctx, r) };
}

/** 見直し候補の一覧（タスクと要望。完了済みも含む）。request を渡すとその要望だけ */
export function reviewCandidates(ctx: P3Context, opts: { request?: string } = {}): ReviewDiagnosis[] {
  const requests = opts.request ? [ctx.ws.requests.require(opts.request)] : ctx.ws.requests.list();
  const out: ReviewDiagnosis[] = [];
  for (const r of requests) {
    const self = requestSelfReview(ctx, r);
    if (isCandidate(self)) out.push(self!);
    for (const t of ctx.ws.tasksOf(r.id).list()) {
      if (!isReviewTarget(t)) continue;
      const d = taskReview(ctx, t);
      if (isCandidate(d)) out.push(d!);
    }
  }
  return out;
}
