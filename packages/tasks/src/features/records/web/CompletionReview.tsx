import { useId, useState } from "react";
import { ACCEPTANCE_RESULT_LABEL, basisLabel } from "../../requirements/shared/acceptance.ts";
import { COMPLETION_TRIGGER_LABEL, REF_CAPTURE_LABEL, type CompletionRecord, type RefCapture } from "../shared/completionRecord.ts";
import { REVIEW_CODE_LABEL, REVIEW_STATE_HINT, REVIEW_STATE_LABEL, type ReviewDiagnosis, type ReviewState } from "../shared/reviewCandidate.ts";
import type { RequestReviewCounts } from "../../../shared/types.ts";
import { fmtTime } from "../../../web/lib/format.ts";
import { Badge, inputCls, type Tone } from "../../../web/components/ui.tsx";

/**
 * 完了時の条件（完了の記録）と、見直しが必要（候補）の表示。判定はしない（API の共通の診断 shared/reviewCandidate.ts をそのまま見せる）。
 * 候補は人の済み・状態を変えず、過去の承認を取り消したようには見せない。記録なし・比較不能は理由と次に確かめる先を出す
 */

const STATE_TONE: Record<ReviewState, Tone> = { candidate: "amber", none: "emerald", no_record: "slate", unreadable: "rose" };

export function ReviewBadge({ state, count, title }: { state: ReviewState; count?: number; title?: string }) {
  return (
    <Badge tone={STATE_TONE[state]} title={title ?? REVIEW_STATE_HINT[state]}>
      {REVIEW_STATE_LABEL[state]}
      {count !== undefined && state === "candidate" ? ` ${count}件` : ""}
    </Badge>
  );
}

/** タスク・要望の見直しの理由（当時と今を対にする） */
export function ReviewPanel({ review, kind = "task" }: { review: ReviewDiagnosis; kind?: "task" | "request" }) {
  const candidate = review.state === "candidate";
  return (
    <section aria-label="見直し" className={candidate ? "min-w-0 space-y-3 rounded-lg bg-amber-50 p-4 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:ring-amber-900" : "min-w-0 space-y-1"}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ReviewBadge state={review.state} count={review.reasons.length} />
        {review.record && <span className="text-base text-slate-500">基点: 完了の記録 {review.record}</span>}
      </div>
      {candidate ? (
        <>
          <p className="text-base">
            {kind === "task" ? "完了した後に条件が変わっています。当時の完了・人の確認の記録は残っています。" : "対応済・完了済にした後に条件が変わっています。当時の記録は残っています。"}
            下の差を見て、今の条件でもよいか確かめてください。
          </p>
          <p className="text-base text-slate-600 dark:text-slate-400">候補を表示しただけでは状態・人の済みは変わりません。今の実装が不適合だと判定したものではありません。確かめたら、もう一度済みにすると新しい記録が基点になります。</p>
          <ul className="min-w-0 space-y-3">
            {review.reasons.map((r) => (
              <li key={`${r.code}:${r.target}`} className="min-w-0 space-y-1.5">
                <p className="font-medium break-words">
                  <span className="font-mono">{r.target}</span> {REVIEW_CODE_LABEL[r.code]}
                  {r.related?.length ? <span className="text-base font-normal text-slate-500">（関係: {r.related.join(", ")}）</span> : null}
                </p>
                <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                  <div className="min-w-0 rounded-md bg-white p-2.5 dark:bg-slate-900">
                    <p className="text-sm text-slate-500">当時{review.record ? `（${review.record}）` : ""}</p>
                    <p className="text-base break-words whitespace-pre-wrap">{r.was ?? "（なし）"}</p>
                  </div>
                  <div className="min-w-0 rounded-md bg-white p-2.5 dark:bg-slate-900">
                    <p className="text-sm text-slate-500">現在</p>
                    <p className="text-base break-words whitespace-pre-wrap">{r.now ?? "（なし）"}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-base text-slate-600 dark:text-slate-400">{REVIEW_STATE_HINT[review.state]}</p>
      )}
      {review.unreadable?.map((u) => (
        <p key={u} className="text-base break-words text-rose-700 dark:text-rose-400">
          比べられない部分: {u}
        </p>
      ))}
    </section>
  );
}

const refLine = (r: RefCapture) =>
  r.state === "ok"
    ? `${r.commit?.slice(0, 12) ?? ""}${r.dirty === true ? "・未コミットの変更あり" : r.dirty === false ? "" : "・未コミットの変更は不明"}`
    : (r.reason ?? REF_CAPTURE_LABEL[r.state]);

const qualityLine = (q: CompletionRecord["quality"]) =>
  `${q.state === "set" ? "設定済" : q.state === "unset" ? "未設定" : "読めない"}・版 ${q.version}${q.repo !== undefined ? `・作業先 ${q.repo ?? "なし"}` : ""}`;

/** 完了時の条件（記録を選んで読む。今の値とは別の写し） */
export function CompletionRecords({ records, problems }: { records?: CompletionRecord[]; problems?: string[] }) {
  const list = records ?? [];
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const selectId = useId();
  const rec = list.find((r) => r.id === picked) ?? list.at(-1);
  return (
    <details className="group min-w-0 rounded-lg ring-1 ring-slate-200 dark:ring-slate-800">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-3 font-semibold">
        完了時の条件
        <span className="text-base font-normal text-slate-500">{list.length ? `記録 ${list.length} 件・最新 ${list.at(-1)!.id}` : problems?.length ? "記録が読めません" : "記録なし"}</span>
      </summary>
      <div className="min-w-0 space-y-3 px-4 pb-4">
        <p className="text-base text-slate-600 dark:text-slate-400">完了・人の済みにしたときの条件の写しです（今の値とは別）。再開しても記録は残ります。参照先のコミットは完了・確認の操作のときに取ったもので、評価のときのものではありません。</p>
        {problems?.map((p) => (
          <p key={p} role="alert" className="text-base break-words text-rose-600">
            読めない記録: {p}（ファイルの completionRecords を直すまで新しい記録は足しません）
          </p>
        ))}
        {list.length > 1 && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <label htmlFor={selectId} className="text-base">
              記録を選ぶ
            </label>
            <select id={selectId} className={`${inputCls} !w-auto max-w-full`} value={rec?.id} onChange={(e) => setPicked(e.target.value)}>
              {list.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} {COMPLETION_TRIGGER_LABEL[r.trigger]} {fmtTime(r.at)}
                </option>
              ))}
            </select>
          </div>
        )}
        {rec && <RecordDetail rec={rec} />}
      </div>
    </details>
  );
}

function RecordDetail({ rec }: { rec: CompletionRecord }) {
  return (
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-base" aria-label={`完了の記録 ${rec.id}`}>
      <dt className="text-slate-500">契機</dt>
      <dd className="min-w-0 break-words">
        {rec.id} {rec.trigger === "task_checked" ? "人の済み（人の最終確認。AI の承認ではありません）" : COMPLETION_TRIGGER_LABEL[rec.trigger]}
      </dd>
      <dt className="text-slate-500">日時・主体</dt>
      <dd className="min-w-0 break-words">
        {fmtTime(rec.at)}・{rec.by ?? "（主体なし）"}・rev {rec.rev}・{rec.status}
        {rec.checked ? "・済み" : ""}
      </dd>
      <dt className="text-slate-500">品質</dt>
      <dd className="min-w-0 break-words">
        {qualityLine(rec.quality)}
        {rec.quality.standards && <span className="block text-slate-600 dark:text-slate-400">項目: {rec.quality.standards.map((s) => `${s.id}${s.exempt ? "（除外）" : ""}`).join(", ") || "なし"}</span>}
        {rec.quality.problems?.map((p) => (
          <span key={p} className="block text-rose-700 dark:text-rose-400">
            読めない: {p}
          </span>
        ))}
      </dd>
      {rec.title !== undefined && (
        <>
          <dt className="text-slate-500">題</dt>
          <dd className="min-w-0 break-words">{rec.title}</dd>
        </>
      )}
      {rec.acceptance && (
        <>
          <dt className="text-slate-500">受け入れ基準</dt>
          <dd className="min-w-0 space-y-1">
            {rec.acceptance.problems?.map((p) => (
              <span key={p} className="block break-words text-rose-700 dark:text-rose-400">
                読めない: {p}
              </span>
            ))}
            {rec.acceptance.criteria?.map((c) => {
              const e = rec.acceptance?.evidence?.find((v) => v.criterionId === c.id);
              return (
                <span key={c.id} className="block min-w-0 break-words">
                  <span className="font-mono">{c.id}</span> {c.text}
                  <span className="block text-slate-600 dark:text-slate-400">{e ? `当時の証拠: ${ACCEPTANCE_RESULT_LABEL[e.result]}・${basisLabel(e)}（作業した側の申告）` : "当時の証拠: なし"}</span>
                </span>
              );
            })}
          </dd>
        </>
      )}
      {(rec.requirement || rec.acceptance?.sources?.length) && (
        <>
          <dt className="text-slate-500">要求の根拠</dt>
          <dd className="min-w-0 break-words">
            {rec.requirement?.problems ? `読めない（${rec.requirement.problems.join(" / ")}）` : (rec.requirement?.sources ?? []).map((s) => `${s.id}${s.source ? ` ${s.source}` : ""}${s.confirmed ? `（確認: ${s.confirmed.by}・${s.confirmed.on}）` : ""}`).join(" / ") || "要望の記録なし"}
            {!!rec.acceptance?.sources?.length && <span className="block text-slate-600 dark:text-slate-400">基準ごと: {rec.acceptance.sources.map((s) => `${s.criterionId}/${s.id}${s.from ? `（${s.from} を写したもの）` : ""}`).join(", ")}</span>}
          </dd>
        </>
      )}
      {(rec.tasks || rec.children?.length) && (
        <>
          <dt className="text-slate-500">判定に使った配下</dt>
          <dd className="min-w-0 break-words">
            {[...(rec.tasks ?? []).map((t) => `${t.id} rev ${t.rev} ${t.status}${t.record ? ` ${t.record}` : "（記録なし）"}`), ...(rec.children ?? []).map((t) => `子 ${t.id} rev ${t.rev} ${t.status}${t.record ? ` ${t.record}` : "（記録なし）"}`)].join(" / ") || "なし"}
          </dd>
        </>
      )}
      <dt className="text-slate-500">参照先</dt>
      <dd className="min-w-0">
        {rec.refs ? (
          rec.refs.length ? (
            rec.refs.map((r) => (
              <span key={r.name} className="block min-w-0 font-mono text-sm break-all">
                {r.name}: {refLine(r)}（取得 {fmtTime(r.at)}）
              </span>
            ))
          ) : (
            "登録なし"
          )
        ) : (
          "取得していません"
        )}
      </dd>
    </dl>
  );
}

/** 要望の配下の候補の件数（親の件数は集約で、親自身を候補とは扱わない） */
export function reviewCountText(c: RequestReviewCounts | undefined): string | undefined {
  if (!c || (!c.tasks && !c.below)) return undefined;
  return [c.tasks ? `自分のタスク ${c.tasks} 件` : "", c.below ? `配下 ${c.below} 件（子の要望とそのタスク）` : ""].filter(Boolean).join("・");
}
