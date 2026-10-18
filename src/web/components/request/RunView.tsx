import { useEffect, useRef, type ReactNode } from "react";
import { type PreflightLogEntry, type Request } from "../../../shared/types.ts";
import { Badge, cx, Meter, scoreTone, Section, type Tone } from "../ui.tsx";
import { type RunInfo } from "../../lib/api.ts";
import { type AppCtx } from "../../lib/appCtx.ts";
import { preflightSteps } from "../../lib/preflightSteps.ts";
import { PreflightScope } from "../PreflightScope.tsx";
import { UiMaterialsPanel } from "../UiMaterials.tsx";
import { isMaterialized } from "../../../shared/preflightInput.ts";
import { staleNotice } from "../../lib/requestEdit.ts";
import { NOTE_INPUT_ID, focusNoteInput } from "./Notes.tsx";
import { Drafts } from "./Drafts.tsx";

/** 表示中の Preflight の run（工程・文脈・ログ・評価・画面資料・メモ・調べた範囲・影響・タスク案） */

const VERDICT = {
  go: { label: "GO — 着手可能", tone: "emerald" as Tone },
  clarify: { label: "要確認", tone: "amber" as Tone },
  no_go: { label: "NO GO", tone: "rose" as Tone },
};

export function RunView({
  ctx,
  request,
  run,
  onChanged,
  onOpenRun,
  notes,
  blocked,
}: {
  ctx: AppCtx;
  request: Request;
  run: RunInfo;
  onChanged: (update: RunInfo | ((cur: RunInfo) => RunInfo)) => void;
  onOpenRun: (runId: string) => void;
  /** メモ欄。評価の下の決まった場所に置く（評価が無い間＝実行中・失敗も同じ場所。入れ替えて作り直さない） */
  notes: ReactNode;
  /** タスク化を止める理由（未保存のタイトル・本文） */
  blocked: string | null;
}) {
  const a = run.assessment;
  const steps = preflightSteps(run);
  // 実行中の run は始めたときの内容で評価している（比べるのは終わってから見せる）
  const stale = run.status === "running" ? null : staleNotice(run.inputMatch, { done: isMaterialized(run) });

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

      {stale && (
        <div role="status" className="space-y-1 rounded-md bg-amber-50 px-4 py-3 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900">
          <p className="font-semibold">{stale.title}</p>
          <p className="break-words">{stale.text}</p>
        </div>
      )}

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

      <LogView log={run.log} running={run.status === "running"} />

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

      {/* 画面資料は評価の下（評価と一緒に、提案の画面イメージを確かめる）。run を替えれば作り直す */}
      {(a || run.ui) && <UiMaterialsPanel key={run.id} requestId={request.id} run={run} />}

      {/* 評価の下。評価が無い間（実行中・失敗）も同じ並びの位置なので、作り直されず入力も消えない */}
      {notes}

      {(a || run.scope) && <PreflightScope scope={run.scope} repos={ctx.info.project.repos} evidence={a ? a.evidence : null} />}

      {a && (
        <>
          <Drafts ctx={ctx} request={request} run={run} onChanged={onChanged} blocked={blocked} />
        </>
      )}
    </div>
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

