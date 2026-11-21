import { Alert, Badge, Button, Empty, Field, inputCls, Loading, linkCls, type Tone } from "@infodb/p3-shared/web/ui.tsx";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { BASIS_LABEL, FOLLOW_UP_KINDS, FOLLOW_UP_LABEL, type FollowUpKind, PHASE_LABEL, STEP_RESULT_LABEL, UNSTABLE_TEXT, VERDICT_LABEL, type ObservationResult, type ResultSummary, type StepRecord, type Verdict } from "../../shared/result.ts";
import { createFollowUp, fetchFollowUp, fetchResults, startResult } from "../lib/api.ts";
import { useLoad } from "../lib/useLoad.ts";

const TONE: Record<Verdict, Tone> = { met: "emerald", unmet: "rose", unconfirmed: "slate" };

/** 結果の状態（完了なら判定、ほかは実行中・中断） */
export function ResultBadge({ r }: { r: Pick<ObservationResult, "status" | "verdict"> }) {
  if (r.status === "completed" && r.verdict) return <Badge tone={TONE[r.verdict]}>{VERDICT_LABEL[r.verdict]}</Badge>;
  return <Badge tone="amber">{r.status === "running" ? "実行中" : "中断"}</Badge>;
}

/** 一覧の「最後の結果」: 判定・日時・古い版での実行・不安定 */
export function SummaryCell({ s }: { s?: ResultSummary }) {
  if (!s?.latest) return <span className="text-slate-600 dark:text-slate-400">未実行</span>;
  const l = s.latest;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <ResultBadge r={l} />
      <span data-aux>{new Date(l.at).toLocaleString()}</span>
      {l.stale && <Badge tone="amber">古い（版 {l.rev} で実行）</Badge>}
      {s.unstable && <Badge tone="rose">不安定</Badge>}
    </span>
  );
}

const basisText = (st: StepRecord) => (st.basis.kind === "machine" ? `${st.basis.command} → ${st.basis.result}` : st.basis.kind === "read" ? st.basis.reference : BASIS_LABEL.declaration);

/** 段の記録（記録した順。同じ段を記録し直したら判定には後のものを使う） */
export function StepList({ steps, label }: { steps: StepRecord[]; label: string }) {
  if (!steps.length) return <Empty>まだ段の記録がありません。</Empty>;
  return (
    <ol aria-label={label} className="list-decimal space-y-1 pl-6">
      {steps.map((st, i) => (
        <li key={i}>
          {PHASE_LABEL[st.phase]} {st.ref}: {STEP_RESULT_LABEL[st.result]}
          {st.measures && `　${Object.entries(st.measures).map(([k, v]) => `${k}=${String(v)}`).join("・")}`}
          <span className="block text-slate-600 dark:text-slate-400">
            根拠（{BASIS_LABEL[st.basis.kind]}）: {basisText(st)}
            {st.evidence ? `／証跡: ${st.evidence}` : ""}
            {st.note ? `／${st.note}` : ""}（{st.by}）
          </span>
        </li>
      ))}
    </ol>
  );
}

/** 1つの結果の中身（版・実行した人・環境・理由・段） */
export function ResultBody({ r, currentRev }: { r: ObservationResult; currentRev: number }) {
  return (
    <div className="space-y-2">
      <p>
        版 {r.rev}
        {r.rev !== currentRev && `（今は版 ${currentRev}。古い結果）`}・{r.startedBy}・開始 {new Date(r.startedAt).toLocaleString()}
        {r.finishedAt && `・終わり ${new Date(r.finishedAt).toLocaleString()}`}
      </p>
      <p>
        環境: {r.environment.repos.map((e) => `${e.name}@${e.commit?.slice(0, 7) ?? "不明"}${e.branch ? `（${e.branch}）` : ""}${e.dirty ? "・未コミットの変更あり" : ""}`).join("、") || "参照先なし"}
        {r.environment.note && `／${r.environment.note}`}
      </p>
      {r.reason && <p>理由: {r.reason}</p>}
      {r.interruptedReason && <p>中断の理由: {r.interruptedReason}</p>}
      {r.teardownProblems?.map((t) => (
        <Alert key={t} warn>
          {t}（判定は変えません）
        </Alert>
      ))}
      <StepList steps={r.steps} label={`${r.id} の段の記録`} />
    </div>
  );
}

/** 観測の詳細の「結果」: 実行を始める（P3 は実行しない）・実行中の続き・不安定・結果ごとの中身 */
export function ResultsSection({ id, rev, ended }: { id: string; rev: number; ended: boolean }) {
  const load = useLoad(() => fetchResults(id), `${id}:${rev}`);
  const navigate = useNavigate();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const start = () => {
    setBusy(true);
    startResult(id, note).then(
      (r) => void navigate({ to: "/observer/$id/runs/$rid", params: { id, rid: r.id } }),
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };
  return (
    <section aria-labelledby="results-heading" className="space-y-3">
      <h2 id="results-heading" className="text-xl font-semibold">
        結果
      </h2>
      <p className="text-slate-600 dark:text-slate-400">P3 は手順を実行しません。あなたか担当の AI が手順に従って実行し、段ごとに記録します。</p>
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>結果を読めませんでした: {load.message}</Alert>}
      {load.kind === "ok" && (
        <>
          {load.value.summary.unstable && <Alert box warn>{UNSTABLE_TEXT}</Alert>}
          {load.value.summary.running && (
            <p>
              <Link to="/observer/$id/runs/$rid" params={{ id, rid: load.value.summary.running }} className={linkCls}>
                実行中の結果の続きを記録する（{load.value.summary.running}）
              </Link>
            </p>
          )}
          {!ended && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-64 flex-1">
                <Field label="環境のメモ（任意）" hint="ブラウザ・データの件数など。参照先ごとのコミットは自動で残ります">
                  <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
              </div>
              <Button variant="primary" disabled={busy} onClick={start}>
                実行を記録する
              </Button>
            </div>
          )}
          {error && <Alert box>{error}</Alert>}
          {load.value.unreadable.map((u) => (
            <Alert key={u.file} warn>
              ⚠ 読めない結果のファイル {u.file}: {u.reason}
            </Alert>
          ))}
          {load.value.results.length === 0 ? (
            <Empty>まだ実行した結果がありません。</Empty>
          ) : (
            <ul className="space-y-2">
              {load.value.results.map((r) => (
                <li key={r.id}>
                  <details className="rounded border border-slate-200 p-3 dark:border-slate-800">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                      <ResultBadge r={r} />
                      {r.rev !== rev && <Badge tone="amber">古い（版 {r.rev} で実行）</Badge>}
                      <span>{new Date(r.finishedAt ?? r.startedAt).toLocaleString()}</span>
                      <span>{r.reason ?? r.interruptedReason ?? ""}</span>
                      <Link to="/observer/$id/runs/$rid" params={{ id, rid: r.id }} className={linkCls}>
                        {r.status === "running" ? "続きを記録する" : "開く"}
                      </Link>
                    </summary>
                    <ResultBody r={r} currentRev={rev} />
                  </details>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** 期待どおりでなかった結果から要望を作る（人が不具合か仕様のずれかを選び、原稿を確かめて明示したときだけ）。作った要望があればそのリンク */
export function FollowUpPanel({ r }: { r: ObservationResult }) {
  const [tick, setTick] = useState(0);
  const load = useLoad(() => fetchFollowUp(r.observation, r.id), `${r.id}:${tick}`);
  const [kind, setKind] = useState<FollowUpKind>("bug");
  const [error, setError] = useState<string>();
  if (load.kind === "loading") return <Loading />;
  if (load.kind === "error") return <Alert>要望の状態を読めませんでした: {load.message}</Alert>;
  const { existing, drafts } = load.value;
  if (existing)
    return (
      <p>
        この結果から作った要望:{" "}
        <Link to="/requests/$requestId" params={{ requestId: existing.request }} className={linkCls}>
          {existing.request} {existing.title}
        </Link>
        （{existing.status}）
      </p>
    );
  if (!drafts) return null;
  return (
    <section aria-labelledby="followup-heading" className="space-y-3 rounded border border-slate-200 p-4 dark:border-slate-800">
      <h2 id="followup-heading" className="text-xl font-semibold">
        要望を作る
      </h2>
      <p>期待どおりでなかった原因を選んでください。選んだ種類の原稿で下書きの要望を作ります（作るまで何も登録しません）。</p>
      <Field label="原因の種類">
        <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as FollowUpKind)}>
          {FOLLOW_UP_KINDS.map((k) => (
            <option key={k} value={k}>
              {FOLLOW_UP_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <p className="font-semibold">{drafts[kind].title}</p>
      <pre className="whitespace-pre-wrap break-all">{drafts[kind].body}</pre>
      {error && <Alert box>{error}</Alert>}
      <Button variant="primary" onClick={() => void createFollowUp(r.observation, r.id, kind).then(() => setTick((t) => t + 1), (e: Error) => setError(e.message))}>
        下書きの要望を作る
      </Button>
    </section>
  );
}
