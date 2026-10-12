import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  REQUEST_STATUSES,
  relationRole,
  type RequestStatus,
  type PreflightLogEntry,
  type PreflightRun,
  type ProposedTask,
  type Request,
  type SupersedeCandidate,
} from "../../../../shared/types.ts";
import { REQUEST_STATUS_LABEL } from "../../../components/RequestStatus.tsx";
import { Badge, Button, buttonCls, cx, Field, inputCls, Empty, Id, Meter, scoreTone, Section, type Tone } from "../../../components/ui.tsx";
import { api, ApiError, type NotesInfo } from "../../../lib/api.ts";
import { archiveSelection } from "../../../lib/supersede.ts";
import { nextRunLabel, notesPanelState, PLAIN_RUN_BLOCKED, submitNote } from "../../../lib/notes.ts";
import { absRef } from "../../../../shared/refs.ts";
import { useAppCtx, type AppCtx } from "../../../lib/appCtx.ts";
import { useRequestData, type RequestData } from "../../../lib/requestData.tsx";
import { useServerEvents } from "../../../lib/live.ts";
import { useEngineStatus } from "../../../lib/engineStatus.ts";
import { optionalString } from "../../../lib/search.ts";
import { preflightSteps } from "../../../lib/preflightSteps.ts";
import { RelationRow } from "../../../components/RelationRow.tsx";
import { RequestIdCopy } from "../../../components/RequestIdCopy.tsx";
import { TagInput } from "../../../components/TagInput.tsx";
import { PreflightScope } from "../../../components/PreflightScope.tsx";
import { sameTags } from "../../../../shared/tags.ts";
import { discardDraft, draftOf, editDraft, isDirty, syncDraft, type Draft } from "../../../lib/draft.ts";

/** 要望の概要と Preflight。?run= で表示する preflight を選ぶ（省くと最新） */
export const Route = createFileRoute("/requests/$requestId/")({
  validateSearch: (s: Record<string, unknown>): { run?: string } => ({ run: optionalString(s.run) }),
  component: RequestPage,
});

function RequestPage() {
  const ctx = useAppCtx();
  const data = useRequestData();
  const { run } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <RequestPanel
      key={data.request.id}
      ctx={ctx}
      data={data}
      runId={run}
      onRunChange={(id) => void navigate({ search: (prev) => ({ ...prev, run: id }) })}
    />
  );
}

const VERDICT = {
  go: { label: "GO — 着手可能", tone: "emerald" as Tone },
  clarify: { label: "要確認", tone: "amber" as Tone },
  no_go: { label: "NO GO", tone: "rose" as Tone },
};

/** 要望の詳細。表示する preflight の run は URL（?run=）で選ぶ。無ければ最新 */
function RequestPanel({
  ctx,
  data,
  runId: selectedRun,
  onRunChange: setRunId,
}: {
  ctx: AppCtx;
  data: RequestData;
  runId?: string;
  onRunChange: (runId: string) => void;
}) {
  const { request, runs } = data;
  const runId = selectedRun ?? request.lastPreflight ?? null;
  const [run, setRun] = useState<PreflightRun>();
  const [error, setError] = useState<string | null>(null);
  // 個人設定を直したら、取り直したとき（タブに戻った・「再読み込み」など）に反映する
  const engine = useEngineStatus(ctx.tick);

  useEffect(() => {
    if (!runId) return setRun(undefined);
    // 取れなければ前の表示のまま（要望が消えた・通信の失敗は要望の枠が知らせる）
    void api.run(request.id, runId).then(setRun, () => undefined);
  }, [runId, request.id, ctx.tick]);

  // ログはストリームで追記
  useServerEvents((e) => {
    if (e.type === "preflight-log" && e.runId === runId) {
      setRun((r) => (r ? { ...r, log: [...r.log, e.entry] } : r));
    } else if (e.type === "preflight-status" && e.runId === runId) {
      void api.run(request.id, runId).then(setRun, () => undefined);
      data.reload();
    }
  });

  function started(r: PreflightRun) {
    setRun(r);
    setRunId(r.id);
    ctx.reload();
  }

  async function start() {
    setError(null);
    try {
      started(await api.startPreflight(request.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const running = run?.status === "running";
  // メモ欄の入力は要望のページにいる間ずっと持つ（run を替えたり実行を始めたりしても消えない）
  const [draft, setDraft] = useState("");
  // 一度でも実行したか（開始した直後、履歴を読み直す前も含める）
  const hasHistory = runs.length > 0 || !!run;
  const notesState = notesPanelState({ hasHistory, running, engineOk: engine?.ok !== false, draft, busy: false, pending: 0 });
  // メモ欄は評価の下（評価を読んでから書くため）。入力中の文はここで持つので、表示が変わっても消えない
  const notes = (
    <Notes
      ctx={ctx}
      request={request}
      hasHistory={hasHistory}
      running={running}
      engineOk={engine?.ok !== false}
      draft={draft}
      onDraft={setDraft}
      onStarted={started}
      gone={data.gone}
    />
  );

  return (
    // ブラウザの幅をそのまま使う（上限なし）。狭い画面では左右の余白を縮める
    <div className="w-full space-y-8 px-4 py-6 sm:px-6 lg:p-8">
      <RequestMeta ctx={ctx} data={data} />

      <section className="space-y-3">
        {request.areas.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {request.areas.map((a) => (
              <Badge key={a} className="max-w-full font-mono">
                {/* 長いパスも全文を見せる（Badge は折り返さないので、中で折り返す） */}
                <span className="min-w-0 whitespace-normal break-all">{a}</span>
              </Badge>
            ))}
          </div>
        )}
        <pre className="font-sans whitespace-pre-wrap break-words rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          {request.body || "（本文なし）"}
        </pre>
      </section>

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-indigo-50 p-4 dark:bg-indigo-950/40">
        <Button variant="primary" onClick={start} disabled={running || engine?.ok === false || notesState.blockPlainRun}>
          {running ? "実行中…" : runs.length ? "▶ もう一度 Preflight" : "▶ Preflight を実行"}
        </Button>
        {engine && (
          <span
            className={cx("text-sm", !engine.ok ? "text-rose-600" : engine.name === "mock" ? "text-amber-700 dark:text-amber-400" : "text-slate-600 dark:text-slate-400")}
            title={engine.name === "mock" ? "PCUBE_PREFLIGHT_ENGINE=mock のときだけ Mock で評価します" : undefined}
          >
            {engine.ok ? "●" : "✕"} {engine.detail}
          </span>
        )}
        {running && run && (
          <Button variant="ghost" onClick={() => api.cancelRun(request.id, run.id)}>
            中止
          </Button>
        )}
        {runs.length > 0 && (
          <select
            className="ml-auto max-w-full min-w-0 rounded-md bg-white px-2 py-1.5 ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-700"
            value={runId ?? ""}
            onChange={(e) => setRunId(e.target.value)}
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} · {r.engine} · {r.status}
              </option>
            ))}
          </select>
        )}
        {notesState.blockPlainRun && <p className="w-full text-sm text-amber-700 dark:text-amber-400">{PLAIN_RUN_BLOCKED}</p>}
        {error && <p className="w-full text-rose-600">{error}</p>}
      </div>

      {run ? (
        <RunView ctx={ctx} request={request} run={run} onChanged={(r) => setRun(r)} onOpenRun={setRunId} notes={notes} />
      ) : (
        // まだ実行していない: 先に保存したメモがあるときだけ見せる（無ければ何も出さない）
        notes
      )}

    </div>
  );
}

function RunView({
  ctx,
  request,
  run,
  onChanged,
  onOpenRun,
  notes,
}: {
  ctx: AppCtx;
  request: Request;
  run: PreflightRun;
  onChanged: (r: PreflightRun) => void;
  onOpenRun: (runId: string) => void;
  /** メモ欄。評価の下の決まった場所に置く（評価が無い間＝実行中・失敗も同じ場所。入れ替えて作り直さない） */
  notes: ReactNode;
}) {
  const a = run.assessment;
  const steps = preflightSteps(run);

  return (
    <div className="space-y-8">
      <ol className="flex items-center gap-2" aria-label="Preflight の工程">
        {steps.map((st, i) => (
          <li key={st.label} className="flex flex-1 items-center gap-2" aria-current={st.current ? "step" : undefined}>
            <span
              className={cx(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                st.state === "done"
                  ? "bg-emerald-500 text-white"
                  : st.state === "failed"
                    ? "bg-rose-500 text-white"
                    : st.state === "current"
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-200 text-slate-500 dark:bg-slate-800",
              )}
            >
              {i + 1}
            </span>
            {/* 狭い画面では今の工程の名前だけを出す（4つの名前は入らない） */}
            <span className={cx("whitespace-nowrap", st.current ? "font-semibold" : "hidden text-slate-500 md:inline")}>
              {st.label}
            </span>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-slate-300 dark:bg-slate-700" />}
          </li>
        ))}
      </ol>

      <p className="text-sm text-slate-600 dark:text-slate-400">
        {run.previous ? (
          <>
            前回{" "}
            <button className="font-mono underline" onClick={() => onOpenRun(run.previous!)}>
              {run.previous}
            </button>{" "}
            の結果を引き継いだ再評価
          </>
        ) : (
          "前回の結果は引き継いでいない評価"
        )}
        {run.notes?.length ? ` · メモ ${run.notes.length} 件を渡した（${run.notes.join(", ")}）` : ""}
        {run.startedBy ? ` · 実行: ${run.startedBy}` : ""}
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section title={`文脈として選ばれた項目 (${run.context.length})`}>
          {run.context.length === 0 ? (
            <Empty>関連する既存項目はありません</Empty>
          ) : (
            <ul className="space-y-2">
              {run.context.map((c) => (
                <li key={c.ref} className="flex gap-3">
                  <div className="w-14 shrink-0 pt-1">
                    <Meter value={Math.min(100, c.score * 100)} tone={c.score > 0.4 ? "emerald" : "amber"} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Id id={c.ref} onClick={() => ctx.open(c.ref)} />
                      <span className="truncate">{c.title}</span>
                    </div>
                    <p className="text-sm break-words text-slate-500">{c.reasons.join(" / ")}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <LogView log={run.log} running={run.status === "running"} />
      </div>

      {run.status === "failed" && <p className="rounded-md bg-rose-50 p-4 text-rose-700 dark:bg-rose-950 dark:text-rose-300">失敗: {run.error}</p>}

      {a && (
          <Section title="評価">
            <div className="space-y-4 rounded-lg bg-white p-5 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
              <div className="flex flex-col items-start gap-2 sm:flex-row sm:gap-3">
                <Badge tone={VERDICT[a.verdict].tone} className="text-base font-semibold">
                  {VERDICT[a.verdict].label}
                </Badge>
                <p className="min-w-0 flex-1 self-stretch break-words">{a.summary}</p>
              </div>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                {(
                  [
                    ["妥当性", a.validity],
                    ["実現可能性", a.feasibility],
                  ] as const
                ).map(([label, s]) => (
                  <div key={label} className="space-y-2">
                    <div className="flex justify-between">
                      <span className="font-medium">{label}</span>
                      <span className="font-mono">{s.score}</span>
                    </div>
                    <Meter value={s.score} tone={scoreTone(s.score)} />
                    <ul className="list-disc space-y-0.5 pl-5 break-words text-slate-600 dark:text-slate-400">
                      {s.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <ListBlock title="リスク" items={a.risks} tone="rose" />
                <ListBlock
                  title="確認事項"
                  items={a.questions}
                  tone="amber"
                  action={
                    a.questions.length > 0 ? (
                      <a href={`#${NOTE_INPUT_ID}`} className="text-sm text-indigo-600 underline" onClick={focusNoteInput}>
                        メモ欄で答える ↓
                      </a>
                    ) : undefined
                  }
                />
              </div>
            </div>
          </Section>
      )}

      {/* 評価の下。評価が無い間（実行中・失敗）も同じ並びの位置なので、作り直されず入力も消えない */}
      {notes}

      {(a || run.scope) && <PreflightScope scope={run.scope} repos={ctx.info.project.repos} evidence={a ? a.evidence : null} />}

      {a && (
        <>
          {a.impacts.length > 0 && (
            <Section title="既存項目への影響（タスク化時に要望の関係として記録）">
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {a.impacts.map((i) => {
                  const ref = absRef(i.target, request.id);
                  return (
                    <li key={`${i.type}-${i.target}`}>
                      <RelationRow
                        role={relationRole(i.type, "out")}
                        tone="amber"
                        refId={i.target}
                        onOpen={ref ? () => ctx.open(ref) : undefined}
                        title={ref ? titleIn(ctx, ref) : undefined}
                        note={i.reason}
                        aside={<span className="font-mono text-sm text-slate-400" title="確信度">{Math.round(i.confidence * 100)}%</span>}
                      />
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          <Drafts ctx={ctx} request={request} run={run} onChanged={onChanged} />
        </>
      )}
    </div>
  );
}

const NOTE_INPUT_ID = "preflight-note";

/** 確認事項からメモ欄へ（入力欄にカーソルを置く） */
function focusNoteInput(e: { preventDefault: () => void }) {
  const el = document.getElementById(NOTE_INPUT_ID) as HTMLTextAreaElement | null;
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.focus({ preventScroll: true });
}

/**
 * Preflight へのメモ（確認事項への回答・方針の変更）。保存すると次の Preflight に前回の結果と一緒に渡す。
 * 引き継ぎ元はいつも直近の run（過去の run を表示していても変わらない）なので、それを先に見せる。
 * 評価の下に置く（評価を読んでから書くため）。まだ一度も実行していなければ出さない。入力中の文は親が持つ。
 */
function Notes({
  ctx,
  request,
  gone,
  hasHistory,
  running,
  engineOk,
  draft,
  onDraft,
  onStarted,
}: {
  ctx: AppCtx;
  request: Request;
  hasHistory: boolean;
  running: boolean;
  engineOk: boolean;
  draft: string;
  onDraft: Dispatch<SetStateAction<string>>;
  onStarted: (r: PreflightRun) => void;
  /** 要望が外で消された（入力は残し、保存はしない） */
  gone: boolean;
}) {
  const [info, setInfo] = useState<NotesInfo>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const pending = info?.notes.filter((n) => n.pending).length ?? 0;
  const st = notesPanelState({ hasHistory, running, engineOk, draft, busy, pending });

  useEffect(() => {
    // 取れなければ前の一覧のまま（入力中のメモには触らない）
    void api.notes(request.id).then(setInfo, () => undefined);
  }, [request.id, ctx.tick]);

  async function submit(run: boolean) {
    if (busy) return;
    if (gone) return setMessage({ error: true, text: "この要望は見つからないので保存しません。入力は残してあります" });
    setBusy(true);
    setMessage(null);
    try {
      const sent = draft;
      const r = await submitNote(api, request.id, sent, run);
      // 保存できたら入力を消す（再試行で同じメモを重ねて保存しない）。保存の前に失敗したら入力は残す。
      // 送った後に書き足していれば、その文は消さない
      onDraft((cur) => (cur === sent ? "" : cur));
      if (r.kind === "started") setMessage({ error: false, text: "メモを保存して、Preflight を始めました" });
      else if (r.kind === "not-started")
        setMessage({ error: true, text: `メモ ${r.note.id} は保存済みです（書き直しは不要）。Preflight を始められませんでした: ${r.error}` });
      else setMessage({ error: false, text: `メモ ${r.note.id} を保存しました。${running ? "実行中の評価ではなく、" : ""}次の Preflight に渡します` });
      if (r.kind === "started") onStarted(r.run);
      setInfo(await api.notes(request.id));
    } catch (e) {
      setMessage({ error: true, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // まだ実行しておらず、保存済みのメモも無ければ何も出さない
  if (st.mode === "intro" && !info?.notes.length && !info?.invalid.length) return null;

  return (
    <Section title="メモ（確認事項への回答・方針の変更）" aside={<span className="font-mono text-sm text-slate-400">requests/{request.id}/notes/*.md</span>}>
      <div className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        {info && (
          <>
            {info.notes.length > 0 && (
              <ul className="space-y-2">
                {info.notes.map((n) => (
                  <li key={n.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
                      <Badge tone={n.pending ? "amber" : "slate"}>{n.pending ? "次に渡す" : "渡し済み"}</Badge>
                      <span className="font-mono">{n.id}</span>
                      <span>{n.createdBy ?? "不明"}</span>
                      <span>{n.createdAt.slice(0, 16).replace("T", " ")}</span>
                    </div>
                    <p className="break-words whitespace-pre-wrap">{n.body}</p>
                  </li>
                ))}
              </ul>
            )}
            {info.invalid.map((i) => (
              <p key={i.file} className="text-sm text-rose-600">
                読めないメモ（渡しません）: {i.file} — {i.error}
              </p>
            ))}
            {st.mode === "input" && <p className="text-sm text-slate-600 dark:text-slate-400">{nextRunLabel(info)}</p>}
          </>
        )}
        {st.hint && <p className="text-sm text-slate-600 dark:text-slate-400">{st.hint}</p>}
        {st.mode === "input" && (
          <>
            <textarea
              id={NOTE_INPUT_ID}
              rows={3}
              className={inputCls}
              value={draft}
              aria-label="Preflight へのメモ"
              placeholder="確認事項への回答や、方針の変更を書きます（例: 対象は CLI だけ。Web は不要）"
              onChange={(e) => onDraft(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled={!st.canSaveAndRun || gone} onClick={() => void submit(true)}>
                保存して再実行
              </Button>
              <Button disabled={!st.canSaveOnly || gone} onClick={() => void submit(false)}>
                {running ? "メモだけ保存（次回に渡す）" : "メモだけ保存"}
              </Button>
            </div>
          </>
        )}
        {message && <p className={message.error ? "text-rose-600" : "text-emerald-700 dark:text-emerald-400"}>{message.text}</p>}
      </div>
    </Section>
  );
}

function ListBlock({ title, items, tone, action }: { title: string; items: string[]; tone: "rose" | "amber"; action?: ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{title}</span>
        {action}
      </div>
      {items.length === 0 ? (
        <p className="text-slate-400">なし</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {items.map((r) => (
            <li key={r} className={cx("rounded px-2 py-1 break-words", tone === "rose" ? "bg-rose-50 dark:bg-rose-950/50" : "bg-amber-50 dark:bg-amber-950/50")}>
              {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LogView({ log, running }: { log: PreflightLogEntry[]; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [log.length]);
  const color = { info: "text-slate-400", command: "text-sky-300", message: "text-slate-100", error: "text-rose-400" };
  return (
    <Section title="実行ログ" aside={running ? <span className="animate-pulse text-sm text-indigo-500">● live</span> : null}>
      <div ref={ref} className="h-72 overflow-y-auto rounded-lg bg-slate-900 p-3 font-mono text-sm leading-relaxed dark:ring-1 dark:ring-slate-800">
        {log.map((l, i) => (
          <div key={i} className={cx("whitespace-pre-wrap break-words", color[l.kind])}>
            <span className="mr-2 text-slate-600">{l.at.slice(11, 19)}</span>
            {l.text}
          </div>
        ))}
      </div>
    </Section>
  );
}

/** タスク案を依存の深さで段に並べる（細分化の構造が一目で分かるように） */
function levels(drafts: ProposedTask[]) {
  const by = new Map(drafts.map((d) => [d.key, d]));
  const memo = new Map<string, number>();
  const depth = (k: string, seen = new Set<string>()): number => {
    if (memo.has(k)) return memo.get(k)!;
    if (seen.has(k)) return 0;
    seen.add(k);
    const d = by.get(k);
    const v = d && d.dependsOn.length ? 1 + Math.max(...d.dependsOn.filter((x) => by.has(x)).map((x) => depth(x, seen)), -1) : 0;
    memo.set(k, v);
    return v;
  };
  const out: ProposedTask[][] = [];
  for (const d of drafts) (out[depth(d.key)] ??= []).push(d);
  return out.filter(Boolean);
}

function Drafts({ ctx, request, run, onChanged }: { ctx: AppCtx; request: Request; run: PreflightRun; onChanged: (r: PreflightRun) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = !!run.materialized?.length && run.materialization?.done !== false;
  const included = run.drafts.filter((d) => d.include);
  // 置き換えられる既存タスク。採否を変えたら・外で変わったら読み直す。アーカイブは選んだものだけ（既定は残す）
  const [candidates, setCandidates] = useState<SupersedeCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const includeKey = run.drafts.map((d) => `${d.key}:${d.include}`).join(",");
  useEffect(() => {
    if (done) return setCandidates([]);
    void api.previewMaterialize(request.id, run.id).then((p) => setCandidates(p.candidates), () => setCandidates([]));
  }, [request.id, run.id, includeKey, done, ctx.tick]);

  async function patch(d: ProposedTask, p: Partial<ProposedTask>) {
    const next = await api.patchDraft(request.id, run.id, d.key, p);
    onChanged({ ...run, drafts: run.drafts.map((x) => (x.key === d.key ? next : x)) });
  }

  async function materialize() {
    setBusy(true);
    setError(null);
    try {
      await api.materialize(request.id, run.id, archiveSelection(candidates, selected));
      onChanged(await api.run(request.id, run.id));
      ctx.reload();
    } catch (e) {
      // 確定の時点で候補が変わっていたら、読み直してもう一度選んでもらう
      setError(
        e instanceof ApiError && e.status === 409
          ? "置き換えられるタスクが他で更新されました。内容を確かめて、もう一度タスク化してください"
          : (e as Error).message,
      );
      void api.previewMaterialize(request.id, run.id).then((p) => setCandidates(p.candidates), () => setCandidates([]));
    } finally {
      setBusy(false);
    }
  }

  if (!run.drafts.length) return <Section title="タスク案"><Empty>タスク案はありません</Empty></Section>;

  return (
    <Section
      title={`タスク案 (${included.length}/${run.drafts.length} 件を採用)`}
      aside={<span className="min-w-0 font-mono text-sm break-all text-slate-400">requests/{request.id}/preflight/{run.id}/drafts/*.md</span>}
    >
      {/* 段（依存の深さ）ごとの列。広い画面では列を広げ（最大 28rem）、入りきらなければこの中だけ横にスクロールする */}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {levels(run.drafts).map((lv, i) => (
          <div key={i} className="flex max-w-md min-w-72 flex-1 shrink-0 flex-col gap-2">
            <span className="text-sm text-slate-500">段階 {i + 1}</span>
            {lv.map((d) => (
              <div
                key={d.key}
                className={cx(
                  "space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800",
                  !d.include && "opacity-50",
                )}
              >
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={d.include} disabled={done} onChange={(e) => patch(d, { include: e.target.checked })} />
                  <span className="font-mono text-sm text-slate-500">{d.key}</span>
                  {d.dependsOn.length > 0 && <span className="text-sm text-slate-400">← {d.dependsOn.join(", ")}</span>}
                </div>
                <textarea
                  rows={2}
                  disabled={done}
                  defaultValue={d.title}
                  onBlur={(e) => e.target.value !== d.title && patch(d, { title: e.target.value })}
                  className="w-full resize-none rounded bg-transparent px-1 leading-snug font-medium hover:ring-1 hover:ring-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none dark:hover:ring-slate-700"
                />
                <details>
                  <summary className="cursor-pointer text-sm text-slate-500">内容</summary>
                  <p className="mt-1 text-sm whitespace-pre-wrap break-words text-slate-600 dark:text-slate-400">{d.description}</p>
                </details>
                <div className="flex flex-wrap gap-1">
                  {d.areas.map((a) => (
                    <Badge key={a} className="max-w-full font-mono" title={a}>
                      <span className="truncate">{a}</span>
                    </Badge>
                  ))}
                  {d.relations.map((r) => (
                    <Badge key={`${r.type}-${r.target}`} tone="amber" className="max-w-full" title={`${relationRole(r.type, "out")} ${r.target}${r.note ? `: ${r.note}` : ""}`}>
                      <span className="shrink-0">{relationRole(r.type, "out")}</span>
                      <span className="truncate font-mono">{r.target}</span>
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {!done && candidates.length > 0 && (
        <div className="space-y-2 rounded-lg bg-amber-50 p-4 dark:bg-amber-950/40">
          <p className="font-medium">置き換えられる既存タスク（チェックしたものをタスク化と一緒にアーカイブします。チェックしなければ残します）</p>
          <ul className="space-y-1.5">
            {candidates.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`${c.id} をアーカイブ`}
                  checked={selected.has(c.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(c.id);
                    else next.delete(c.id);
                    setSelected(next);
                  }}
                />
                <Id id={c.id} onClick={() => ctx.open(c.ref)} />
                <span>{c.title}</span>
                {c.status === "doing" && (
                  <Badge tone="amber" title="アーカイブしても、進めている作業そのものは止まりません">
                    作業中
                  </Badge>
                )}
                <span className="text-sm text-slate-500">
                  {c.reasons.map((r) => (r.source === "draft" ? `案 ${r.draft}` : "評価")).join(" · ")}
                  {c.reasons[0]?.note ? ` — ${c.reasons[0].note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center gap-3 pt-2">
        {done ? (
          <p className="flex flex-wrap items-center gap-2 text-emerald-700 dark:text-emerald-400">
            ✓ この評価から {run.materialized!.join(", ")} をタスク化しました
            {run.materialization?.archived.length ? `（置き換えられた ${run.materialization.archived.join(", ")} をアーカイブ）` : ""}
            <Link to="/requests/$requestId/board" params={{ requestId: request.id }} className={buttonCls("ghost", "underline")}>
              タスクボードで見る
            </Link>
          </p>
        ) : (
          <>
            <Button variant="primary" disabled={busy || !included.length} onClick={materialize}>
              {included.length} 件をタスク化{selected.size && candidates.some((c) => selected.has(c.id)) ? `（${archiveSelection(candidates, selected).length} 件をアーカイブ）` : ""}
            </Button>
            <span className="text-slate-500">依存関係・影響関係も一緒に登録され、作業ツリー（ブランチ）が割り当てられます。</span>
          </>
        )}
        {error && <span className="text-rose-600">{error}</span>}
      </div>
    </Section>
  );
}

/** 要望の管理情報（ID・タイトル・ステータス・期限・マイルストーン・タグ）。変えるとすぐ保存する。期限〜タグは Preflight には渡さない */
function RequestMeta({ ctx, data }: { ctx: AppCtx; data: RequestData }) {
  const { request } = data;
  // タイトル・タグの入力は下書きで持つ（取り直しても編集中は上書きしない。保存は編集を始めたときの rev で）
  const [titleD, setTitleD] = useState(() => draftOf(request.title, request.rev));
  const [tagsD, setTagsD] = useState(() => draftOf<string[]>(request.tags, request.rev));
  const [tagsBusy, setTagsBusy] = useState(false);
  /** タグの入力欄の、まだ足していない文字（取り直しても残す） */
  const [tagText, setTagText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 値に何が入っていても区切りにならない文字でつなぐ（配列は取り直すたびに別物になるので、中身で比べる）
  const tagsKey = request.tags.join("\u0000");
  useEffect(() => {
    setTitleD((d) => syncDraft(d, request.title, request.rev));
    setTagsD((d) => syncDraft(d, request.tags, request.rev, sameTags));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.title, tagsKey, request.rev]);

  async function save(
    patch: { title?: string; status?: RequestStatus; due?: string | null; milestone?: string | null; tags?: string[] },
    rev = request.rev,
  ): Promise<Request | null> {
    if (data.gone) {
      setError("この要望は見つからないので保存しません");
      return null;
    }
    try {
      const saved = await api.patchRequest(request.id, { ...patch, rev } as never);
      setError(null);
      data.reload();
      ctx.reload();
      return saved;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError("競合: 他で更新されています。入力は残してあります（最新を見るには「入力を捨てて最新にする」）");
        data.reload();
      } else setError((e as Error).message);
      return null;
    }
  }

  async function commitTitle() {
    const v = titleD.value.trim();
    if (!v || v === titleD.base) return setTitleD((d) => ({ ...d, value: d.base }));
    const saved = await save({ title: v }, titleD.baseRev);
    if (saved) setTitleD(draftOf(saved.title, saved.rev));
  }

  /** タグは足す・外すたびに保存する（編集を始めたときの rev で。保存中は次の操作を待たせる） */
  async function changeTags(next: string[]) {
    setTagsD((d) => editDraft(d, next));
    setTagsBusy(true);
    const saved = await save({ tags: next }, tagsD.baseRev);
    if (saved) setTagsD(draftOf(saved.tags, saved.rev));
    setTagsBusy(false);
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <RequestIdCopy id={request.id} />
        <Field label="タイトル">
          <input
            className={`${inputCls} text-lg font-semibold`}
            value={titleD.value}
            onChange={(e) => setTitleD((d) => editDraft(d, e.target.value))}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </Field>
        <ExternalChange label="タイトル" draft={titleD} onDiscard={() => (setTitleD((d) => discardDraft(d)), setError(null))} />
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <Field label="ステータス">
          <select className={`${inputCls} !w-36`} value={request.status} onChange={(e) => void save({ status: e.target.value as RequestStatus })}>
            {REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {REQUEST_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="期限">
          <input type="date" className={`${inputCls} !w-44`} value={request.due ?? ""} onChange={(e) => void save({ due: e.target.value || null })} />
        </Field>
        <Field label="マイルストーン">
          <select className={`${inputCls} !w-56`} value={request.milestone ?? ""} onChange={(e) => void save({ milestone: e.target.value || null })}>
            <option value="">（なし）</option>
            {ctx.info.project.milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
                {m.due ? `（${m.due}）` : ""}
              </option>
            ))}
          </select>
        </Field>
        {ctx.info.project.milestones.length === 0 && (
          <Link to="/settings" className={buttonCls("ghost", "mt-7 text-sm underline")}>
            マイルストーンを設定で作る
          </Link>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="request-tags" className="text-sm font-medium text-slate-500 dark:text-slate-400">
          タグ（外部 ID や分類。値ごとに Enter で足し、× で外す。すぐ保存）
        </label>
        <TagInput id="request-tags" tags={tagsD.value} onChange={(next) => void changeTags(next)} disabled={tagsBusy || data.gone} text={tagText} onText={setTagText} />
      </div>
      <ExternalChange
        label="タグ"
        draft={tagsD}
        eq={sameTags}
        show={(v) => (v.length ? v.join("、") : "なし")}
        onDiscard={() => (setTagsD((d) => discardDraft(d)), setError(null))}
      />
      {data.issue && (
        <p className="flex flex-wrap items-center gap-3 rounded-md bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {data.issue}
          <Button onClick={() => void save({ status: "active" })}>進行中に戻す</Button>
        </p>
      )}
      {request.status === "resolved" && !data.issue && (
        <p className="text-sm text-sky-700 dark:text-sky-300">
          作業は全部終わっています。成果物を確かめたら、ステータスを「完了済」にしてください。
        </p>
      )}
      {error && <p className="text-rose-600">{error}</p>}
    </section>
  );
}

/** 参照の題（要望か、どの要望のタスクでも。進捗の一覧から引く） */
function titleIn(ctx: AppCtx, ref: string): string | undefined {
  const [rid, tid] = ref.split("/");
  const p = ctx.requests.find((x) => x.request.id === rid);
  if (!p) return undefined;
  return tid ? p.tasks.find((t) => t.id === tid)?.title : p.request.title;
}

/** 編集中に外で変わったことを知らせる（入力はそのまま。捨てると最新の値にする） */
function ExternalChange<V>({
  label,
  draft,
  eq,
  show = String,
  onDiscard,
}: {
  label: string;
  draft: Draft<V>;
  eq?: (a: V, b: V) => boolean;
  show?: (v: V) => string;
  onDiscard: () => void;
}) {
  if (!draft.external || !isDirty(draft, eq)) return null;
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
      <span className="min-w-0 break-words">
        編集中に{label}が他で変わりました（rev {draft.external.rev}: 「{show(draft.external.value)}」）。このまま保存すると競合になります。
      </span>
      <Button onClick={onDiscard}>入力を捨てて最新にする</Button>
    </p>
  );
}
