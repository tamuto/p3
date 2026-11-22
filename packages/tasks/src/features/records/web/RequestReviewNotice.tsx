import type { AppCtx } from "../../../web/lib/appCtx.ts";
import type { RequestData } from "../../../web/lib/requestData.tsx";
import { CompletionRecords, ReviewBadge, ReviewPanel, reviewCountText } from "./CompletionReview.tsx";
import { Button, Id } from "@infodb/p3-shared/web/ui.tsx";

/**
 * 要望の概要の見直しが必要（候補）: 要望自身（対応済・完了済）の理由と、自分のタスク・配下の候補の件数とタスクへの操作。
 * 判定は API の共通の結果（data.review）をそのまま見せる。候補が無ければ何も出さない（記録なし・差分なしの要望で欄を増やさない）。
 * 完了済みのタスクも対象（タスクボードの済み・対応済みの一覧からも開ける）
 */
export function RequestReviewNotice({ ctx, data }: { ctx: AppCtx; data: RequestData }) {
  const review = data.review;
  const request = data.request;
  const records = request.completionRecords;
  if (!review && !records?.length) return null;
  const self = review?.self;
  const showSelf = self && (self.state === "candidate" || self.state === "unreadable");
  const candidates = data.tasks.filter((t) => review?.tasks[t.id]?.state === "candidate");
  const counts = reviewCountText(review?.counts);
  if (!showSelf && !counts && !records?.length && !request.completionProblems?.length) return null;
  return (
    <section aria-label="要望の見直し" className="min-w-0 space-y-3">
      {showSelf && <ReviewPanel review={self} kind="request" />}
      {counts && (
        <div className="min-w-0 space-y-2 rounded-lg bg-warn-soft p-4 ring-1 ring-warn-line">
          <p className="font-medium">見直しが必要（候補）: {counts}</p>
          <p className="text-base text-fg-3">完了済みのタスクの状態と人の済みはそのままです。タスクを開いて当時と今の条件を比べてください。配下の件数は子の要望で開けます。</p>
          {candidates.length > 0 && (
            <ul className="min-w-0 space-y-1">
              {candidates.map((t) => (
                <li key={t.id} className="flex min-w-0 flex-wrap items-center gap-2">
                  <Id id={t.id} />
                  <span className="min-w-0 break-words">{t.title}</span>
                  <ReviewBadge state="candidate" count={review!.tasks[t.id].reasons} />
                  <Button variant="secondary" onClick={() => ctx.open(t.ref)}>
                    当時と現在を見る
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {(!!records?.length || !!request.completionProblems?.length) && <CompletionRecords records={records} problems={request.completionProblems} />}
    </section>
  );
}
