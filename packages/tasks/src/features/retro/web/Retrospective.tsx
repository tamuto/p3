import { useCallback, useEffect, useId, useState } from "react";
import {
  ADOPTION_KIND_LABEL,
  EVIDENCE_CHECK_LABEL,
  MILESTONE_REVIEW_SECTIONS,
  RETRO_EVIDENCE_LABEL,
  RISK_STATE_LABEL,
  RISK_STATES,
  TASK_REVIEW_SECTIONS,
  type EvidenceCheck,
  type EvidenceRef,
  type RetroCandidate,
  type RetroEvidence,
  type RetroRiskView,
  type RetrospectiveView,
  type RiskJudgment,
  type RiskState,
} from "../shared/retrospective.ts";
import { reworkLine } from "../../records/shared/reworkHistory.ts";
import type { AppCtx } from "../../../web/lib/appCtx.ts";
import { api, errorCode } from "../../../web/lib/api.ts";
import { fmtTime } from "../../../web/lib/format.ts";
import type { RequestData } from "../../../web/lib/requestData.tsx";
import { useUnsaved } from "../../../web/lib/unsaved.ts";
import { Alert, Badge, Button, inputCls, type Tone } from "@infodb/p3-shared/web/ui.tsx";

/**
 * 要望の概要の「リスクの振り返り」。Preflight で心配したリスクが実装の後に起きたかを、人が確かめて残す（規則は shared/retrospective.ts）。
 * 振り返る評価（採用済みの run）は人が確定し、上の Preflight の履歴で別の run を開いても変わらない。確認は人の判断で、根拠を結び付けるだけでは
 * 未確認のまま。保存は読んだときの版で行い、他で変わっていれば入力を残して知らせる
 */

const STATE_TONE: Record<RiskState, Tone> = { occurred: "rose", not_occurred: "emerald", unchecked: "slate" };
const CHECK_TONE: Record<EvidenceCheck, Tone> = { ok: "emerald", changed: "amber", missing: "rose", manual: "slate" };
const SECTION_LABEL: Record<string, string> = { overall: "全体の所見", items: "基準ごとの所見", quality: "品質の所見", unplanned: "意図しない変更の候補", checks: "人が確かめる点", units: "予定機能ごとの所見" };

const saveError = (e: unknown) =>
  errorCode(e) === "retro_conflict"
    ? "他で振り返りが更新されました。最新を読み直しました。入力は残してあるので、確かめてからもう一度保存してください"
    : errorCode(e) === "retro_unreadable"
      ? `振り返りの記録が読めません（retrospective.json を直してください）: ${(e as Error).message}`
      : `${(e as Error).message}（入力は残してあります）`;

export function RetrospectivePanel({ ctx, data }: { ctx: AppCtx; data: RequestData }) {
  const rid = data.request.id;
  const [view, setView] = useState<RetrospectiveView>();
  const [error, setError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const load = useCallback(async () => {
    try {
      setView(await api.retrospective(rid));
      setError(null);
    } catch (e) {
      // 読めないときは前の表示のまま知らせる（「未確定」「候補なし」に置き換えない）
      setError(`振り返りを読み込めませんでした: ${(e as Error).message}`);
    }
  }, [rid]);
  useEffect(() => {
    void load();
  }, [load, ctx.tick]);

  const target = view?.target;
  return (
    <section aria-label="リスクの振り返り" className="min-w-0 space-y-3 rounded-lg p-4 ring-1 ring-slate-200 dark:ring-slate-800">
      <div className="flex min-w-0 flex-wrap items-baseline gap-2">
        <h3 className="text-lg font-semibold">リスクの振り返り</h3>
        {view && target && (
          <span className="text-base text-slate-600 dark:text-slate-400">
            起きた {view.counts.occurred}件・起きなかった {view.counts.not_occurred}件・未確認 {view.counts.unchecked}件
          </span>
        )}
      </div>
      <p className="text-base text-slate-600 dark:text-slate-400">
        Preflight で心配したリスクが、実装の後に起きたかを人が確かめて残します。振り返る評価は上の Preflight の履歴で別の評価を開いても変わりません。
        {data.request.milestone ? ` マイルストーン ${data.request.milestone} のレビューの所見も根拠にできます。` : " マイルストーン未設定でも、タスクのレビューと手戻りを根拠にできます。"}
      </p>
      {error && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-base text-rose-600">
          {error}
          <Button variant="secondary" onClick={() => void load()}>
            再読み込み
          </Button>
        </p>
      )}
      {!view ? null : !target ? (
        view.candidates.length ? (
          <CandidatePicker rid={rid} data={data} view={view} onSaved={setView} onReload={load} />
        ) : (
          <p className="text-base text-slate-600 dark:text-slate-400">振り返れる評価はありません: {view.none}</p>
        )
      ) : (
        <>
          <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-base">
            <dt className="text-slate-500">確定した評価</dt>
            <dd className="min-w-0 break-all">
              <span className="font-mono">{target.run}</span>（{ADOPTION_KIND_LABEL[target.kind]}）
            </dd>
            <dt className="text-slate-500">採用の根拠</dt>
            <dd className="min-w-0 break-words">{basisText(target.basis, data)}</dd>
            <dt className="text-slate-500">確定</dt>
            <dd className="min-w-0 break-words">
              {target.by ?? "（主体なし）"}・{fmtTime(target.at)}
              {target.replaces ? `（${target.replaces} を訂正: ${target.reason ?? ""}）` : ""}
            </dd>
          </dl>
          {view.risks.length ? (
            <ul className="min-w-0 space-y-2">
              {view.risks.map((r) => (
                <RiskRow key={r.index} rid={rid} data={data} view={view} risk={r} onSaved={setView} onReload={load} />
              ))}
            </ul>
          ) : (
            <p className="text-base text-slate-600 dark:text-slate-400">リスクなし（確定した評価にリスクがありませんでした）</p>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {view.candidates.filter((c) => c.run !== target.run).length > 0 && <span className="text-base text-slate-600 dark:text-slate-400">選択外の採用済み評価 {view.candidates.filter((c) => c.run !== target.run).length} 件</span>}
            <Button variant="secondary" onClick={() => setCorrecting((v) => !v)} aria-expanded={correcting}>
              対象を訂正する
            </Button>
            {view.targets.length > 1 && (
              <Button variant="secondary" onClick={() => setShowPast((v) => !v)} aria-expanded={showPast}>
                過去の対象を見る
              </Button>
            )}
          </div>
          {correcting && (
            <CandidatePicker
              rid={rid}
              data={data}
              view={view}
              correcting
              onSaved={(v) => {
                setView(v);
                setCorrecting(false);
              }}
              onReload={load}
            />
          )}
          {showPast && <PastTargets view={view} />}
        </>
      )}
    </section>
  );
}

function basisText(basis: RetroCandidate["basis"], data: RequestData): string {
  return (
    basis
      .map((b) => {
        const title = data.tasks.find((t) => t.id === b.target)?.title;
        const state = { present: "", archived: "（アーカイブ済み）", missing: "（見つからない）", mismatch: "（採用元が合わない）" }[b.state];
        return `${b.target}${title ? ` ${title}` : ""}${state}`;
      })
      .join("、") || "なし"
  );
}

/** 候補を比べて対象を確定する（訂正なら理由が要る） */
function CandidatePicker({ rid, data, view, correcting, onSaved, onReload }: { rid: string; data: RequestData; view: RetrospectiveView; correcting?: boolean; onSaved: (v: RetrospectiveView) => void; onReload: () => Promise<void> }) {
  const name = useId();
  const [run, setRun] = useState(view.candidates.find((c) => c.run !== view.target?.run)?.run ?? view.candidates[0]?.run);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useUnsaved(!!correcting && !!reason.trim());
  const save = async () => {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.confirmRetrospective(rid, { run, ...(correcting ? { reason } : {}), version: view.version }));
    } catch (e) {
      setError(saveError(e));
      if (errorCode(e) === "retro_conflict") void onReload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-base">{correcting ? "別の採用済み評価に訂正します。前の対象と判断は消えずに残ります。" : "振り返る評価は未確定です。採用した内容を見て1つ選びます。"}</p>
      <fieldset className="min-w-0 space-y-2">
        <legend className="sr-only">振り返る評価</legend>
        {view.candidates.map((c) => (
          <label key={c.run} className="block min-w-0 cursor-pointer rounded-md p-3 ring-1 ring-slate-200 dark:ring-slate-700">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <input type="radio" name={name} value={c.run} checked={run === c.run} onChange={() => setRun(c.run)} />
              <span className="font-mono break-all">{c.run}</span>
              {c.latest && <Badge tone="indigo">最新の採用済み</Badge>}
              {view.target?.run === c.run && <Badge>今の対象</Badge>}
            </span>
            <span className="mt-1 block min-w-0 text-base break-words text-slate-600 dark:text-slate-400">
              {ADOPTION_KIND_LABEL[c.kind]}・{basisText(c.basis, data)}・リスク {c.risks}件
            </span>
          </label>
        ))}
      </fieldset>
      {correcting && (
        <TextField label="訂正の理由" value={reason} onChange={setReason} rows={2} disabled={busy} />
      )}
      {error && <Alert>{error}</Alert>}
      <Button variant="primary" disabled={busy || !run || (correcting && !reason.trim())} onClick={() => void save()}>
        {busy ? "保存中…" : correcting ? "この評価に訂正する" : "この評価を振り返る"}
      </Button>
    </div>
  );
}

function TextField({ label, value, onChange, rows = 3, disabled }: { label: string; value: string; onChange: (v: string) => void; rows?: number; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-base">
        {label}
      </label>
      <textarea id={id} rows={rows} className={inputCls} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function evidenceWhere(e: RetroEvidence): string {
  if (e.kind === "task_review") return `${e.task} ${e.run}・${SECTION_LABEL[e.section] ?? e.section} ${e.index + 1}`;
  if (e.kind === "milestone_review") return `${e.milestone} ${e.run}・${SECTION_LABEL[e.section] ?? e.section} ${e.index + 1}`;
  if (e.kind === "rework") return `${e.task} ${e.history}`;
  return e.reference;
}

function EvidenceItem({ e, check }: { e: RetroEvidence; check?: EvidenceCheck }) {
  return (
    <li className="min-w-0 space-y-0.5">
      <p className="flex min-w-0 flex-wrap items-center gap-2 text-base">
        <span>{RETRO_EVIDENCE_LABEL[e.kind]}</span>
        <span className="min-w-0 font-mono text-sm break-all">{evidenceWhere(e)}</span>
        {check && <Badge tone={CHECK_TONE[check]}>{EVIDENCE_CHECK_LABEL[check]}</Badge>}
      </p>
      {e.kind !== "manual" && <p className="text-base break-words text-slate-600 dark:text-slate-400">当時の抜粋: {e.excerpt}</p>}
      {e.kind === "manual" && e.note && <p className="text-base break-words text-slate-600 dark:text-slate-400">{e.note}</p>}
      {e.kind === "milestone_review" && (
        <p className="text-sm break-words text-slate-500">
          記録のみ（参考のレビュー）{e.inputChanged ? "。実行中に材料が変わった" : ""}
          {e.reason ? `。結び付く理由: ${e.reason}` : ""}
        </p>
      )}
      {e.kind === "task_review" && <p className="text-sm text-slate-500">記録のみ（参考のレビュー。テストやアプリは動かしていません）</p>}
    </li>
  );
}

function JudgmentItem({ j, checks }: { j: RiskJudgment; checks?: EvidenceCheck[] }) {
  return (
    <li className="min-w-0 space-y-1 border-l-2 border-slate-200 pl-3 dark:border-slate-700">
      <p className="flex min-w-0 flex-wrap items-center gap-2 text-base">
        <Badge tone={STATE_TONE[j.state]}>{RISK_STATE_LABEL[j.state]}</Badge>
        <span className="text-slate-600 dark:text-slate-400">
          {j.id}・{j.by ?? "（主体なし）"}・{fmtTime(j.at)}
        </span>
      </p>
      {j.reason && <p className="text-base break-words">訂正の理由: {j.reason}</p>}
      {j.scope && <p className="text-base break-words">確認した範囲: {j.scope}</p>}
      {j.facts && <p className="text-base break-words">確認した事実: {j.facts}</p>}
      {j.evidence.length > 0 && (
        <ul className="min-w-0 space-y-1.5">
          {j.evidence.map((e, i) => (
            <EvidenceItem key={i} e={e} check={checks?.[i]} />
          ))}
        </ul>
      )}
    </li>
  );
}

function RiskRow({ rid, data, view, risk, onSaved, onReload }: { rid: string; data: RequestData; view: RetrospectiveView; risk: RetroRiskView; onSaved: (v: RetrospectiveView) => void; onReload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="min-w-0 space-y-2 rounded-md p-3 ring-1 ring-slate-200 dark:ring-slate-700" data-testid={`risk-${risk.index + 1}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge tone={STATE_TONE[risk.state]}>{RISK_STATE_LABEL[risk.state]}</Badge>
        <span className="min-w-0 flex-1 break-words">
          {risk.index + 1}. {risk.text}
        </span>
        <Button variant={risk.state === "unchecked" ? "primary" : "secondary"} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {risk.state === "unchecked" ? "根拠を照合して確認する" : "確認と根拠を見る"}
        </Button>
      </div>
      {open && (
        <div className="min-w-0 space-y-3">
          {risk.history.length > 0 && (
            <ul className="min-w-0 space-y-2" aria-label={`リスク ${risk.index + 1} の確認の履歴`}>
              {risk.history.map((j) => (
                <JudgmentItem key={j.id} j={j} checks={view.checks[j.id]} />
              ))}
            </ul>
          )}
          <JudgeForm rid={rid} data={data} view={view} risk={risk} onSaved={onSaved} onReload={onReload} onCancel={() => setOpen(false)} />
        </div>
      )}
    </li>
  );
}

/** 確認結果の入力（状態・範囲・事実・理由と、結び付ける根拠） */
function JudgeForm({ rid, data, view, risk, onSaved, onReload, onCancel }: { rid: string; data: RequestData; view: RetrospectiveView; risk: RetroRiskView; onSaved: (v: RetrospectiveView) => void; onReload: () => Promise<void>; onCancel: () => void }) {
  const stateId = useId();
  const [state, setState] = useState<RiskState>(risk.state);
  const [scope, setScope] = useState("");
  const [facts, setFacts] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState<EvidenceRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decided = risk.state !== "unchecked";
  const dirty = state !== risk.state || !!scope.trim() || !!facts.trim() || !!reason.trim() || evidence.length > 0;
  useUnsaved(dirty);
  const missing =
    state === "occurred" && (!facts.trim() || !evidence.length)
      ? "「起きた」には確認した事実と根拠が要ります"
      : state === "not_occurred" && (!scope.trim() || !evidence.length)
        ? "「起きなかった」には確認した範囲と根拠が要ります"
        : decided && !reason.trim()
          ? "確認済みの判断を変える・未確認に戻すには理由が要ります"
          : state === "unchecked" && !evidence.length && !risk.judgment
            ? "未確認のままにするなら、結び付ける根拠を足してください"
            : null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.judgeRisk(rid, { risk: risk.index, state, ...(scope.trim() ? { scope } : {}), ...(facts.trim() ? { facts } : {}), ...(reason.trim() ? { reason } : {}), evidence, version: view.version }));
      setScope("");
      setFacts("");
      setReason("");
      setEvidence([]);
    } catch (e) {
      setError(saveError(e));
      if (errorCode(e) === "retro_conflict") void onReload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-w-0 space-y-2 rounded-md bg-slate-50 p-3 dark:bg-slate-800/50" role="group" aria-label={`リスク ${risk.index + 1} の確認結果`}>
      <p className="text-sm text-slate-500">確認は人の判断です。根拠を結び付けるだけでは未確認のままです。</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label htmlFor={stateId} className="text-base">
          確認結果
        </label>
        <select id={stateId} className={`${inputCls} !w-auto`} value={state} disabled={busy} onChange={(e) => setState(e.target.value as RiskState)}>
          {RISK_STATES.map((s) => (
            <option key={s} value={s}>
              {RISK_STATE_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      {state !== "unchecked" && <TextField label="確認した範囲（対象の成果・時点・範囲）" value={scope} onChange={setScope} rows={2} disabled={busy} />}
      {state === "occurred" && <TextField label="確認した事実" value={facts} onChange={setFacts} rows={2} disabled={busy} />}
      {decided && <TextField label="訂正の理由" value={reason} onChange={setReason} rows={2} disabled={busy} />}
      {evidence.length > 0 && (
        <ul className="min-w-0 space-y-1" aria-label="結び付ける根拠">
          {evidence.map((e, i) => (
            <li key={i} className="flex min-w-0 flex-wrap items-center gap-2 text-base">
              <span>{RETRO_EVIDENCE_LABEL[e.kind]}</span>
              <span className="min-w-0 font-mono text-sm break-all">{refText(e)}</span>
              <Button variant="secondary" disabled={busy} onClick={() => setEvidence(evidence.filter((_, j) => j !== i))} aria-label={`根拠 ${i + 1} を外す`}>
                外す
              </Button>
            </li>
          ))}
        </ul>
      )}
      <EvidenceAdder rid={rid} data={data} disabled={busy} onAdd={(e) => setEvidence([...evidence, e])} />
      {missing && <p className="text-base text-amber-700 dark:text-amber-400">{missing}</p>}
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || !!missing} onClick={() => void save()}>
          {busy ? "保存中…" : "確認結果を保存する"}
        </Button>
        <Button variant="cancel" disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

function refText(e: EvidenceRef): string {
  if (e.kind === "task_review") return `${e.task} ${e.run} ${SECTION_LABEL[e.section]} ${(e.index ?? 0) + 1}`;
  if (e.kind === "milestone_review") return `${e.milestone} ${e.run} ${SECTION_LABEL[e.section]} ${(e.index ?? 0) + 1}`;
  if (e.kind === "rework") return `${e.task} ${e.history}`;
  return e.reference;
}

/** 根拠を1つ選んで足す（種類ごとに、この要望のタスク・レビュー・手戻りから選ぶ。保存するときにサーバが照らす） */
function EvidenceAdder({ rid, data, disabled, onAdd }: { rid: string; data: RequestData; disabled?: boolean; onAdd: (e: EvidenceRef) => void }) {
  const ids = { kind: useId(), task: useId(), run: useId(), section: useId(), index: useId(), history: useId(), ms: useId() };
  const [kind, setKind] = useState<EvidenceRef["kind"]>("task_review");
  const [task, setTask] = useState(data.tasks[0]?.id ?? "");
  const [run, setRun] = useState("");
  const [runs, setRuns] = useState<string[] | null>(null);
  const [section, setSection] = useState("overall");
  const [index, setIndex] = useState("1");
  const [history, setHistory] = useState("");
  const [milestone, setMilestone] = useState(data.request.milestone ?? "");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  // レビューの run の一覧（終わったものだけ）。読めなければ手で入れる
  useEffect(() => {
    let live = true;
    setRuns(null);
    const p =
      kind === "task_review" && task
        ? api.taskReviews(rid, task).then((r) => r.items.flatMap((i) => (i.state === "ok" && i.run.status === "completed" ? [i.run.id] : [])))
        : kind === "milestone_review" && milestone
          ? api.reviews(milestone).then((r) => r.items.flatMap((i) => (i.state === "ok" && i.run.status === "completed" ? [i.run.id] : [])))
          : Promise.resolve([] as string[]);
    p.then(
      (l) => {
        if (!live) return;
        setRuns(l);
        setRun(l[0] ?? "");
      },
      () => live && setRuns([]),
    );
    return () => {
      live = false;
    };
  }, [kind, task, milestone, rid]);
  const reworks = data.tasks.find((t) => t.id === task)?.reworkHistory ?? [];
  const sections: readonly string[] = kind === "milestone_review" ? MILESTONE_REVIEW_SECTIONS : TASK_REVIEW_SECTIONS;
  const idx = Math.max(0, Number(index) - 1 || 0);
  const ref: EvidenceRef | undefined =
    kind === "task_review" && task && run
      ? { kind, task, run, section: section as never, index: idx }
      : kind === "milestone_review" && milestone && run
        ? { kind, milestone, run, section: section as never, index: idx }
        : kind === "rework" && task && history
          ? { kind, task, history }
          : kind === "manual" && reference.trim()
            ? { kind, reference: reference.trim(), ...(note.trim() ? { note: note.trim() } : {}) }
            : undefined;
  const sel = `${inputCls} !w-auto max-w-full`;
  return (
    <fieldset className="min-w-0 space-y-2 rounded-md p-2 ring-1 ring-slate-200 dark:ring-slate-700">
      <legend className="px-1 text-base">根拠を追加する</legend>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <div className="min-w-0">
          <label htmlFor={ids.kind} className="block text-sm text-slate-600 dark:text-slate-400">
            種類
          </label>
          <select id={ids.kind} className={sel} value={kind} disabled={disabled} onChange={(e) => (setKind(e.target.value as EvidenceRef["kind"]), setSection("overall"))}>
            {(["task_review", "milestone_review", "rework", "manual"] as const).map((k) => (
              <option key={k} value={k}>
                {RETRO_EVIDENCE_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        {(kind === "task_review" || kind === "rework") && (
          <div className="min-w-0">
            <label htmlFor={ids.task} className="block text-sm text-slate-600 dark:text-slate-400">
              タスク
            </label>
            <select id={ids.task} className={sel} value={task} disabled={disabled} onChange={(e) => setTask(e.target.value)}>
              {data.tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} {t.title}
                </option>
              ))}
            </select>
          </div>
        )}
        {kind === "milestone_review" && (
          <div className="min-w-0">
            <label htmlFor={ids.ms} className="block text-sm text-slate-600 dark:text-slate-400">
              マイルストーン
            </label>
            <input id={ids.ms} className={`${inputCls} !w-32`} value={milestone} disabled={disabled} onChange={(e) => setMilestone(e.target.value.trim())} />
          </div>
        )}
        {(kind === "task_review" || kind === "milestone_review") && (
          <>
            <div className="min-w-0">
              <label htmlFor={ids.run} className="block text-sm text-slate-600 dark:text-slate-400">
                レビュー
              </label>
              {runs?.length ? (
                <select id={ids.run} className={sel} value={run} disabled={disabled} onChange={(e) => setRun(e.target.value)}>
                  {runs.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : (
                <input id={ids.run} className={`${inputCls} !w-48`} value={run} placeholder={runs ? "終わったレビューなし" : "読み込み中…"} disabled={disabled} onChange={(e) => setRun(e.target.value.trim())} />
              )}
            </div>
            <div className="min-w-0">
              <label htmlFor={ids.section} className="block text-sm text-slate-600 dark:text-slate-400">
                所見
              </label>
              <select id={ids.section} className={sel} value={section} disabled={disabled} onChange={(e) => setSection(e.target.value)}>
                {sections.map((s) => (
                  <option key={s} value={s}>
                    {SECTION_LABEL[s]}
                  </option>
                ))}
              </select>
            </div>
            {section !== "overall" && (
              <div className="min-w-0">
                <label htmlFor={ids.index} className="block text-sm text-slate-600 dark:text-slate-400">
                  何番目
                </label>
                <input id={ids.index} type="number" min={1} className={`${inputCls} !w-20`} value={index} disabled={disabled} onChange={(e) => setIndex(e.target.value)} />
              </div>
            )}
          </>
        )}
        {kind === "rework" && (
          <div className="min-w-0">
            <label htmlFor={ids.history} className="block text-sm text-slate-600 dark:text-slate-400">
              手戻りの履歴
            </label>
            <select id={ids.history} className={sel} value={history} disabled={disabled || !reworks.length} onChange={(e) => setHistory(e.target.value)}>
              <option value="">{reworks.length ? "選ぶ" : "履歴なし"}</option>
              {reworks.map((h) => (
                <option key={h.id} value={h.id}>
                  {reworkLine(h)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {kind === "manual" && (
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          <TextField label="参照（成果物・検証の結果の URL やパス）" value={reference} onChange={setReference} rows={1} disabled={disabled} />
          <TextField label="補足（任意）" value={note} onChange={setNote} rows={1} disabled={disabled} />
        </div>
      )}
      <Button
        variant="secondary"
        disabled={disabled || !ref}
        onClick={() => {
          if (!ref) return;
          onAdd(ref);
          setReference("");
          setNote("");
        }}
      >
        根拠に加える
      </Button>
    </fieldset>
  );
}

function PastTargets({ view }: { view: RetrospectiveView }) {
  const past = view.targets.slice(0, -1);
  return (
    <div className="min-w-0 space-y-3" aria-label="過去の対象">
      {past.map((t) => {
        const js = view.judgments.filter((j) => j.target === t.id);
        return (
          <div key={t.id} className="min-w-0 space-y-1 rounded-md p-3 ring-1 ring-slate-200 dark:ring-slate-700">
            <p className="text-base break-all">
              {t.id} <span className="font-mono">{t.run}</span>（{ADOPTION_KIND_LABEL[t.kind]}）・{t.by ?? ""}・{fmtTime(t.at)}
            </p>
            {js.length ? (
              <ul className="min-w-0 space-y-2">
                {js.map((j) => (
                  <li key={j.id} className="min-w-0 space-y-1">
                    <p className="text-base break-words">
                      リスク {j.risk + 1}: {j.riskText}
                    </p>
                    <ul className="min-w-0">
                      <JudgmentItem j={j} checks={view.checks[j.id]} />
                    </ul>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-base text-slate-500">確認の記録なし</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
