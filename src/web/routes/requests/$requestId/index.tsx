import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  REQUEST_STATUSES,
  RELATION_TYPES,
  type RequestStatus,
  type PreflightLogEntry,
  type PreflightRun,
  type ProposedTask,
  type Request,
} from "../../../../shared/types.ts";
import { REQUEST_STATUS_LABEL } from "../../../components/RequestStatus.tsx";
import { Badge, Button, buttonCls, cx, Field, inputCls, Empty, Id, Meter, scoreTone, Section, type Tone } from "../../../components/ui.tsx";
import { api, type EngineStatus } from "../../../lib/api.ts";
import { absRef } from "../../../../shared/refs.ts";
import { useAppCtx, type AppCtx } from "../../../lib/appCtx.ts";
import { useRequestData, type RequestData } from "../../../lib/requestData.tsx";
import { useServerEvents } from "../../../lib/live.ts";
import { optionalString } from "../../../lib/search.ts";

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
  const [engine, setEngine] = useState<EngineStatus>();

  useEffect(() => {
    void api.engine().then(setEngine);
  }, []);

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
      data.reload();
    }
  });

  async function start() {
    setError(null);
    try {
      const r = await api.startPreflight(request.id);
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
      <RequestMeta ctx={ctx} data={data} />

      <section className="space-y-3">
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
      </section>

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-indigo-50 p-4 dark:bg-indigo-950/40">
        <Button variant="primary" onClick={start} disabled={running || engine?.ok === false}>
          {running ? "実行中…" : runs.length ? "▶ もう一度 Preflight" : "▶ Preflight を実行"}
        </Button>
        {engine && (
          <span
            className={cx("text-sm", !engine.ok ? "text-rose-600" : engine.name === "mock" ? "text-amber-700 dark:text-amber-400" : "text-slate-600 dark:text-slate-400")}
            title={engine.name === "mock" ? "pcube 本体の .env に PCUBE_CODEX_AUTH_VOLUME などを設定すると Codex で評価します" : undefined}
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
                <li key={c.ref} className="flex gap-3">
                  <div className="w-14 shrink-0 pt-1">
                    <Meter value={Math.min(100, c.score * 100)} tone={c.score > 0.4 ? "emerald" : "amber"} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Id id={c.ref} onClick={() => ctx.open(c.ref)} />
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
                    <Id id={i.target} onClick={() => { const ref = absRef(i.target, request.id); if (ref) ctx.open(ref); }} />
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
      title={`タスク案 (${included.length}/${run.drafts.length} 件を採用)`}
      aside={<span className="font-mono text-sm text-slate-400">requests/{request.id}/preflight/{run.id}/drafts/*.md</span>}
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
          <p className="flex flex-wrap items-center gap-2 text-emerald-700 dark:text-emerald-400">
            ✓ この評価から {run.materialized!.join(", ")} をタスク化しました
            <Link to="/requests/$requestId/board" params={{ requestId: request.id }} className={buttonCls("ghost", "underline")}>
              タスクボードで見る
            </Link>
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

/** 要望の管理項目（期限・マイルストーン・タグ）。変えるとすぐ保存する */
/** 要望の管理情報（タイトル・ステータス・期限・マイルストーン・タグ）。期限〜タグは Preflight には渡さない */
function RequestMeta({ ctx, data }: { ctx: AppCtx; data: RequestData }) {
  const { request } = data;
  const [title, setTitle] = useState(request.title);
  const [tags, setTags] = useState(request.tags.join(", "));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setTitle(request.title), [request.title]);
  useEffect(() => setTags(request.tags.join(", ")), [request.tags]);

  async function save(patch: { title?: string; status?: RequestStatus; due?: string | null; milestone?: string | null; tags?: string[] }) {
    try {
      await api.patchRequest(request.id, { ...patch, rev: request.rev } as never);
      setError(null);
      data.reload();
      ctx.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const tagList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  return (
    <section className="space-y-4">
      <Field label="タイトル">
        <input
          className={`${inputCls} text-lg font-semibold`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (!title.trim()) return setTitle(request.title);
            if (title.trim() !== request.title) void save({ title: title.trim() });
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </Field>
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
        <Field label="タグ（カンマ区切り）">
          <input
            className={`${inputCls} !w-64`}
            value={tags}
            placeholder="feature, ui"
            onChange={(e) => setTags(e.target.value)}
            onBlur={() => tagList(tags).join() !== request.tags.join() && void save({ tags: tagList(tags) })}
          />
        </Field>
        {ctx.info.project.milestones.length === 0 && (
          <Link to="/settings" className={buttonCls("ghost", "mt-7 text-sm underline")}>
            マイルストーンを設定で作る
          </Link>
        )}
      </div>
      {error && <p className="text-rose-600">{error}</p>}
    </section>
  );
}
