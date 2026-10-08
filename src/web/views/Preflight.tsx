import { useEffect, useRef, useState } from "react";
import {
  RELATION_TYPES,
  type PreflightLogEntry,
  type PreflightRun,
  type ProposedTask,
  type Request,
  type RequestStatus,
  type Task,
} from "../../shared/types.ts";
import type { AppCtx } from "../App.tsx";
import { Badge, Button, cx, Empty, Field, Id, inputCls, Meter, scoreTone, Section, type Tone } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { streamColor } from "../lib/colors.ts";
import { useServerEvents } from "../lib/live.ts";

const STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
  draft: { label: "下書き", tone: "slate" },
  preflight: { label: "評価中", tone: "indigo" },
  reviewed: { label: "評価済み", tone: "amber" },
  accepted: { label: "タスク化済み", tone: "emerald" },
  rejected: { label: "見送り", tone: "rose" },
};

const VERDICT = {
  go: { label: "GO — 着手可能", tone: "emerald" as Tone },
  clarify: { label: "要確認", tone: "amber" as Tone },
  no_go: { label: "NO GO", tone: "rose" as Tone },
};

export function Preflight({ ctx, selected, onSelect }: { ctx: AppCtx; selected: string | null; onSelect: (id: string | null) => void }) {
  const [creating, setCreating] = useState(false);
  const current = ctx.requests.find((r) => r.id === selected);

  return (
    <div className="flex h-full">
      <aside className="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="font-semibold">要望</h2>
          <Button variant="primary" onClick={() => (setCreating(true), onSelect(null))}>
            ＋ 新しい要望
          </Button>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {[...ctx.requests].reverse().map((r) => (
            <li key={r.id}>
              <button
                onClick={() => (setCreating(false), onSelect(r.id))}
                className={cx(
                  "flex w-full flex-col gap-1 border-l-4 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800",
                  r.id === selected ? "bg-indigo-50/60 dark:bg-indigo-950/40" : "",
                )}
                style={{ borderLeftColor: r.status === "accepted" ? streamColor(r.id) : "transparent" }}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-slate-500">{r.id}</span>
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                </div>
                <span className="leading-snug">{r.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {creating ? (
          <NewRequest
            onCreated={(id) => {
              setCreating(false);
              ctx.reload();
              onSelect(id);
            }}
          />
        ) : current ? (
          <RequestPanel key={current.id} ctx={ctx} request={current} />
        ) : (
          <Intro />
        )}
      </div>
    </div>
  );
}

function Intro() {
  const steps = [
    ["要望を書く", "やりたいことを自由に記述。1要望 = 1作業ツリー（ブランチ）になります。"],
    ["文脈を選ぶ", "インテリジェンス層が、内容・影響領域・関係グラフから関係しそうな過去/現在の仕事を絞り込みます。"],
    ["Codex が評価", "コンテナ内の Codex がリポジトリを読み、妥当性・実現可能性・影響を評価してファイルに書き出します。"],
    ["案を直してタスク化", "タスク案（1案 = 1ファイル）を取捨選択・編集し、依存関係ごとタスクとして登録します。"],
  ];
  return (
    <div className="mx-auto max-w-3xl p-10">
      <h1 className="text-2xl font-bold">Preflight</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-400">着手する前に、要望を検証し、実行可能なタスクへ分解します。左から要望を選ぶか、新しく作成してください。</p>
      <ol className="mt-8 grid gap-4 sm:grid-cols-2">
        {steps.map(([t, d], i) => (
          <li key={t} className="rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <div className="flex items-center gap-2 font-semibold">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-sm text-white">{i + 1}</span>
              {t}
            </div>
            <p className="mt-2 text-slate-600 dark:text-slate-400">{d}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function NewRequest({ onCreated }: { onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [areas, setAreas] = useState("");
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-8">
      <h2 className="text-xl font-bold">新しい要望</h2>
      <Field label="タイトル">
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="内容（背景・やりたいこと・完了条件。箇条書きはタスク案の手がかりになります）">
        <textarea rows={12} className={`${inputCls} font-mono`} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <Field label="影響しそうな領域（任意・カンマ区切り。例: src/server/api, auth）">
        <input className={`${inputCls} font-mono`} value={areas} onChange={(e) => setAreas(e.target.value)} />
      </Field>
      <Button
        variant="primary"
        disabled={!title.trim()}
        onClick={async () => {
          const r = await api.createRequest({ title, body, areas: areas.split(",").map((s) => s.trim()).filter(Boolean) });
          onCreated(r.id);
        }}
      >
        作成
      </Button>
    </div>
  );
}

function RequestPanel({ ctx, request }: { ctx: AppCtx; request: Request }) {
  const [runs, setRuns] = useState<PreflightRun[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runId, setRunId] = useState<string | null>(request.lastPreflight ?? null);
  const [run, setRun] = useState<PreflightRun>();
  const [engine, setEngine] = useState(ctx.info.defaultEngine);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const d = await api.request(request.id);
    setRuns(d.runs);
    setTasks(d.tasks);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.tick, request.id]);

  useEffect(() => {
    if (!runId) return setRun(undefined);
    void api.run(request.id, runId).then(setRun);
  }, [runId, request.id, ctx.tick]);

  // ログはストリームで追記
  useServerEvents((e) => {
    if (e.type === "preflight-log" && e.runId === runId) {
      setRun((r) => (r ? { ...r, log: [...r.log, e.entry] } : r));
    } else if (e.type === "preflight-status" && e.runId === runId) {
      void api.run(request.id, runId).then(setRun);
      void load();
    }
  });

  async function start() {
    setError(null);
    try {
      const r = await api.startPreflight(request.id, engine);
      setRun(r);
      setRunId(r.id);
      ctx.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const running = run?.status === "running";

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-8">
      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-slate-500">{request.id}</span>
          <Badge tone={STATUS[request.status].tone}>{STATUS[request.status].label}</Badge>
          {request.workstream && (
            <Badge tone="emerald" title={request.workstream.worktree}>
              ⎇ {request.workstream.branch}
            </Badge>
          )}
        </div>
        <h1 className="text-2xl font-bold">{request.title}</h1>
        {request.areas.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {request.areas.map((a) => (
              <Badge key={a} className="font-mono">
                {a}
              </Badge>
            ))}
          </div>
        )}
        <pre className="font-sans whitespace-pre-wrap rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          {request.body || "（本文なし）"}
        </pre>
      </header>

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-indigo-50 p-4 dark:bg-indigo-950/40">
        <Button variant="primary" onClick={start} disabled={running}>
          {running ? "実行中…" : runs.length ? "▶ もう一度 Preflight" : "▶ Preflight を実行"}
        </Button>
        <select className="rounded-md bg-white px-2 py-1.5 ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-700" value={engine} onChange={(e) => setEngine(e.target.value as typeof engine)}>
          {ctx.info.engines.map((en) => (
            <option key={en} value={en}>
              {en === "codex" ? "Codex (codex-workspace)" : "Mock (オフライン)"}
            </option>
          ))}
        </select>
        {running && run && (
          <Button variant="ghost" onClick={() => api.cancelRun(request.id, run.id)}>
            中止
          </Button>
        )}
        {runs.length > 0 && (
          <select
            className="ml-auto rounded-md bg-white px-2 py-1.5 ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-700"
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
        {error && <p className="w-full text-rose-600">{error}</p>}
      </div>

      {run && <RunView ctx={ctx} request={request} run={run} onChanged={(r) => setRun(r)} />}

      {tasks.length > 0 && (
        <Section title={`この要望のタスク (${tasks.length})`}>
          <ul className="divide-y divide-slate-100 rounded-lg bg-white ring-1 ring-slate-200 dark:divide-slate-800 dark:bg-slate-900 dark:ring-slate-800">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-2">
                <Id id={t.id} onClick={() => ctx.openTask(t.id)} />
                <span className="flex-1">{t.title}</span>
                <Badge>{ctx.info.project.statuses.find((s) => s.id === t.status)?.label ?? t.status}</Badge>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function RunView({ ctx, request, run, onChanged }: { ctx: AppCtx; request: Request; run: PreflightRun; onChanged: (r: PreflightRun) => void }) {
  const a = run.assessment;
  const step = run.status === "running" ? (run.log.length > 1 ? 2 : 1) : run.materialized?.length ? 4 : run.status === "completed" ? 3 : 2;
  const steps = ["文脈選定", "評価・細分化", "レビュー", "タスク化"];

  return (
    <div className="space-y-8">
      <ol className="flex items-center gap-2">
        {steps.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-2">
            <span
              className={cx(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                i + 1 < step || (i + 1 === step && step === 4)
                  ? "bg-emerald-500 text-white"
                  : i + 1 === step
                    ? run.status === "failed"
                      ? "bg-rose-500 text-white"
                      : "bg-indigo-600 text-white"
                    : "bg-slate-200 text-slate-500 dark:bg-slate-800",
              )}
            >
              {i + 1}
            </span>
            <span className={cx("whitespace-nowrap", i + 1 === step ? "font-semibold" : "text-slate-500")}>{s}</span>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-slate-300 dark:bg-slate-700" />}
          </li>
        ))}
      </ol>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={`文脈として選ばれた項目 (${run.context.length})`}>
          {run.context.length === 0 ? (
            <Empty>関連する既存項目はありません</Empty>
          ) : (
            <ul className="space-y-2">
              {run.context.map((c) => (
                <li key={c.id} className="flex gap-3">
                  <div className="w-14 shrink-0 pt-1">
                    <Meter value={Math.min(100, c.score * 100)} tone={c.score > 0.4 ? "emerald" : "amber"} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Id id={c.id} onClick={() => (c.kind === "task" ? ctx.openTask(c.id) : ctx.openRequest(c.id))} />
                      <span className="truncate">{c.title}</span>
                    </div>
                    <p className="text-sm text-slate-500">{c.reasons.join(" / ")}</p>
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
        <>
          <Section title="評価">
            <div className="space-y-4 rounded-lg bg-white p-5 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
              <div className="flex items-start gap-3">
                <Badge tone={VERDICT[a.verdict].tone} className="text-base font-semibold">
                  {VERDICT[a.verdict].label}
                </Badge>
                <p className="flex-1">{a.summary}</p>
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
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
                    <ul className="list-disc space-y-0.5 pl-5 text-slate-600 dark:text-slate-400">
                      {s.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <ListBlock title="リスク" items={a.risks} tone="rose" />
                <ListBlock title="確認事項" items={a.questions} tone="amber" />
              </div>
            </div>
          </Section>

          {a.impacts.length > 0 && (
            <Section title="既存項目への影響（タスク化時に要望の関係として記録）">
              <ul className="space-y-1.5">
                {a.impacts.map((i) => (
                  <li key={`${i.type}-${i.target}`} className="flex items-start gap-2">
                    <Badge tone="amber">{RELATION_TYPES[i.type].label}</Badge>
                    <Id id={i.target} onClick={() => (i.target.startsWith("REQ") ? ctx.openRequest(i.target) : ctx.openTask(i.target))} />
                    <span className="text-slate-600 dark:text-slate-400">{i.reason}</span>
                    <span className="ml-auto font-mono text-sm text-slate-400">{Math.round(i.confidence * 100)}%</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Drafts ctx={ctx} request={request} run={run} onChanged={onChanged} />
        </>
      )}
    </div>
  );
}

function ListBlock({ title, items, tone }: { title: string; items: string[]; tone: "rose" | "amber" }) {
  return (
    <div>
      <span className="font-medium">{title}</span>
      {items.length === 0 ? (
        <p className="text-slate-400">なし</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {items.map((r) => (
            <li key={r} className={cx("rounded px-2 py-1", tone === "rose" ? "bg-rose-50 dark:bg-rose-950/50" : "bg-amber-50 dark:bg-amber-950/50")}>
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
          <div key={i} className={cx("whitespace-pre-wrap", color[l.kind])}>
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
  const done = !!run.materialized?.length;
  const included = run.drafts.filter((d) => d.include);
  const total = included.reduce((s, d) => s + d.estimateDays, 0);

  async function patch(d: ProposedTask, p: Partial<ProposedTask>) {
    const next = await api.patchDraft(request.id, run.id, d.key, p);
    onChanged({ ...run, drafts: run.drafts.map((x) => (x.key === d.key ? next : x)) });
  }

  async function materialize() {
    setBusy(true);
    setError(null);
    try {
      await api.materialize(request.id, run.id);
      onChanged(await api.run(request.id, run.id));
      ctx.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!run.drafts.length) return <Section title="タスク案"><Empty>タスク案はありません</Empty></Section>;

  return (
    <Section
      title={`タスク案 (${included.length}/${run.drafts.length} 件 · ${total} 人日)`}
      aside={<span className="font-mono text-sm text-slate-400">preflight/{request.id}/{run.id}/drafts/*.md</span>}
    >
      <div className="flex gap-3 overflow-x-auto pb-2">
        {levels(run.drafts).map((lv, i) => (
          <div key={i} className="flex w-72 shrink-0 flex-col gap-2">
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
                  <input
                    type="number"
                    step="0.5"
                    disabled={done}
                    defaultValue={d.estimateDays}
                    onBlur={(e) => Number(e.target.value) !== d.estimateDays && patch(d, { estimateDays: Number(e.target.value) })}
                    className="ml-auto w-16 rounded bg-transparent px-1 text-right ring-1 ring-slate-200 dark:ring-slate-700"
                  />
                  <span className="text-sm text-slate-500">人日</span>
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
                  <p className="mt-1 text-sm whitespace-pre-wrap text-slate-600 dark:text-slate-400">{d.description}</p>
                </details>
                <div className="flex flex-wrap gap-1">
                  {d.areas.map((a) => (
                    <Badge key={a} className="font-mono">
                      {a}
                    </Badge>
                  ))}
                  {d.relations.map((r) => (
                    <Badge key={`${r.type}-${r.target}`} tone="amber" title={r.note}>
                      {RELATION_TYPES[r.type].label} {r.target}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 pt-2">
        {done ? (
          <p className="text-emerald-700 dark:text-emerald-400">
            ✓ タスク化済み:{" "}
            {run.materialized!.map((id) => (
              <Id key={id} id={id} onClick={() => ctx.openTask(id)} />
            ))}
          </p>
        ) : (
          <>
            <Button variant="primary" disabled={busy || !included.length} onClick={materialize}>
              {included.length} 件をタスク化
            </Button>
            <span className="text-slate-500">依存関係・影響関係も一緒に登録され、作業ツリー（ブランチ）が割り当てられます。</span>
          </>
        )}
        {error && <span className="text-rose-600">{error}</span>}
      </div>
    </Section>
  );
}
