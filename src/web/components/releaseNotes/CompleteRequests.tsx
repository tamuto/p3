import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { RequestCompletionPlan, RequestCompletionResult } from "../../../shared/types.ts";
import { api, ApiError } from "../../lib/api.ts";
import { Button, cx } from "../ui.tsx";

const REQUEST_ID = /^\d{6}-[a-z0-9]{5}$/;

type Outcome =
  | { kind: "done"; result: RequestCompletionResult }
  | { kind: "partial"; result: RequestCompletionResult }
  | { kind: "rejected"; text: string }
  | { kind: "error"; text: string };

/**
 * マイルストーンの要望を一括で完了済にする（対応済 → 完了済。タスクの済み・ノート・マイルストーンは変えない）。
 * できるか・対象・できない理由はサーバの判定（plan）をそのまま出す（ここで条件を作り直さない）。確かめの欄を開いたときの判定を
 * 固定し、その basedOn で頼む（後で変わっていればサーバが何も書かずに断る。自動では頼み直さない）。
 * ノートの保存・要約の生成・マイルストーンのリリース済みとは別の操作
 */
export function CompleteRequests({ plan, title, onChanged }: { plan: RequestCompletionPlan; title: string; onChanged: () => void }) {
  /** 確かめている判定（開いたときのもの） */
  const [confirming, setConfirming] = useState<RequestCompletionPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const n = plan.targets.length;

  const close = () => {
    setConfirming(null);
    opener.current?.focus();
  };

  async function run(p: RequestCompletionPlan) {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome({ kind: "done", result: await api.completeReleaseRequests(p.milestone, p.basedOn) });
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string; result?: RequestCompletionResult }) : undefined;
      if (body?.code === "partial" && body.result) setOutcome({ kind: "partial", result: body.result });
      else if (body?.code === "material_changed" || body?.code === "blocked") {
        setOutcome({ kind: "rejected", text: `${(e as Error).message}（表示を最新にしました。内容を確かめてから、もう一度実行してください）` });
      } else setOutcome({ kind: "error", text: `実行できませんでした: ${(e as Error).message}（何が変わったかは表示で確かめてください）` });
    } finally {
      setBusy(false);
      setConfirming(null);
      onChanged();
    }
  }

  return (
    <section aria-labelledby="rn-complete" className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <h4 id="rn-complete" className="font-semibold">
        要望の一括完了
      </h4>
      {!plan.ready ? (
        <div className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <p>一括で完了済にできません。見送り以外の全要望が、全タスク完了の対応済か完了済になっている必要があります。</p>
          <ul className="space-y-0.5">
            {plan.blockers.map((b) => (
              <li key={b.target} className="break-words">
                ✕ {b.reason}{" "}
                {REQUEST_ID.test(b.target) && (
                  <Link to="/requests/$requestId" params={{ requestId: b.target }} className="whitespace-nowrap underline">
                    要望を開く →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : n === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">完了済にする要望はありません</p>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">対応済の要望 {n} 件を完了済にできます（タスクの「済み」は変えません）。</p>
      )}

      {/* 確かめている間も出しておく（キャンセルでフォーカスを戻す先） */}
      <Button
        ref={opener}
        variant="primary"
        aria-expanded={!!confirming}
        disabled={!plan.ready || n === 0 || busy}
        onClick={() => {
          if (confirming) return;
          setOutcome(null);
          setConfirming(plan);
        }}
      >
        要望を一括で完了済にする{plan.ready && n > 0 ? `（${n}件）` : ""}
      </Button>

      {confirming && (
        <div role="group" aria-labelledby="rn-complete-confirm" className="space-y-2 rounded-md border border-indigo-200 bg-indigo-50 p-3 text-sm dark:border-indigo-900 dark:bg-indigo-950/50">
          <p id="rn-complete-confirm" className="font-semibold break-words">
            「{title}」の要望 {confirming.targets.length} 件を完了済にしますか？
          </p>
          <ul className="list-disc space-y-0.5 pl-5">
            {confirming.targets.map((t) => (
              <li key={t.id} className="break-words">
                {t.title} <span className="font-mono text-slate-500">{t.id}</span>
              </li>
            ))}
          </ul>
          <p>要望の状態を「対応済」から「完了済」にします。タスクの「済み」は変更しません。</p>
          <p>保存した本文と出典はそのままです（実行後は「材料が変わった」と出ます）。</p>
          <div className="flex flex-wrap gap-2">
            <Button autoFocus disabled={busy} onClick={close}>
              キャンセル
            </Button>
            <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => void run(confirming)}>
              {busy ? "完了済にしています…" : `${confirming.targets.length}件を完了済にする`}
            </Button>
          </div>
        </div>
      )}

      {outcome && <OutcomeView outcome={outcome} />}
    </section>
  );
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === "rejected" || outcome.kind === "error") {
    return (
      <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm break-words text-rose-800 dark:bg-rose-950 dark:text-rose-300">
        {outcome.text}
      </p>
    );
  }
  const r = outcome.result;
  const ok = outcome.kind === "done";
  return (
    <div
      role={ok ? "status" : "alert"}
      className={cx(
        "space-y-1 rounded-md px-3 py-2 text-sm break-words",
        ok ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
      )}
    >
      <p>{ok ? (r.completed.length ? `${r.completed.length} 件を完了済にしました` : "完了済にする要望はありませんでした（何も変えていません）") : "途中で止まりました（完了済にした分は戻していません）"}</p>
      {!ok && (
        <ul className="space-y-0.5">
          <li>完了済にした: {r.completed.length ? r.completed.map((t) => t.id).join(", ") : "なし"}</li>
          {r.failed && (
            <li>
              止まった: {r.failed.id}（{r.failed.reason}）
            </li>
          )}
          <li>まだ変えていない: {r.notRun.length ? r.notRun.join(", ") : "なし"}</li>
          <li>表示を最新にしました。原因を直してから、もう一度実行すると残りを完了済にします。</li>
        </ul>
      )}
    </div>
  );
}
