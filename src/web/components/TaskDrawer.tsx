import { useEffect, useState } from "react";
import { normalizeTaskId } from "../../shared/refs.ts";
import { RELATION_TYPES, relationTypes, type GraphEdge, type Neighborhood, type RelationType, type Task } from "../../shared/types.ts";
import type { AppCtx } from "../lib/appCtx.ts";
import { api, ApiError } from "../lib/api.ts";
import { fmtTime } from "../lib/format.ts";
import type { RequestData } from "../lib/requestData.tsx";
import { DoneMark } from "./Marks.tsx";
import { Badge, Button, Empty, Field, Id, inputCls, Section } from "./ui.tsx";

type Draft = Pick<Task, "title" | "status" | "body"> & { labels: string; areas: string; outputs: string };

const toDraft = (t: Task): Draft => ({
  title: t.title,
  status: t.status,
  body: t.body,
  labels: t.labels.join(", "),
  areas: t.areas.join(", "),
  outputs: t.outputs.join("\n"),
});

const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/**
 * タスク詳細（要望の画面に重ねる）。id は要望の中の ID（T003。T3 / 3 も可）。
 * 関係の相手は、同じ要望のタスクは T003、別の要望は <要望ID> か <要望ID>/T003 と書く。
 */
export function TaskDrawer({ ctx, data, id: rawId, onClose }: { ctx: AppCtx; data: RequestData; id: string; onClose: () => void }) {
  const rid = data.request.id;
  const id = `${rid}/${normalizeTaskId(rawId) ?? rawId}`;
  const [task, setTask] = useState<Task>();
  const [graph, setGraph] = useState<Neighborhood>();
  const [draft, setDraft] = useState<Draft>();
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [relType, setRelType] = useState<RelationType>("depends_on");
  const [relTarget, setRelTarget] = useState("");

  const load = async () => {
    const r = await api.task(id);
    setTask(r.task);
    setGraph(r.graph);
    if (!dirty) setDraft(toDraft(r.task));
  };

  useEffect(() => {
    setDirty(false);
    setMsg(null);
    void api.task(id).then((r) => {
      setTask(r.task);
      setGraph(r.graph);
      setDraft(toDraft(r.task));
    });
  }, [id]);

  // 外部更新の反映。編集中なら上書きせず通知だけ
  useEffect(() => {
    if (!task) return;
    void api.task(id).then((r) => {
      if (r.task.rev !== task.rev && dirty) setMsg(`他で更新されました (rev ${r.task.rev}${r.task.updatedBy ? ` by ${r.task.updatedBy}` : ""})`);
      setGraph(r.graph);
      if (!dirty) {
        setTask(r.task);
        setDraft(toDraft(r.task));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.tick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!task || !draft || !graph) return null;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft({ ...draft, [k]: v });
    setDirty(true);
  };
  /** 同じ要望の中は T003 と短く見せる */
  const short = (ref: string) => (ref.startsWith(`${rid}/`) ? ref.slice(rid.length + 1) : ref);
  const title = (ref: string) => graph.titles[ref] ?? data.tasks.find((t) => t.ref === ref)?.title ?? "";
  const open = (ref: string) => ctx.open(ref);

  async function save() {
    try {
      await api.patchTask(id, {
        ...draft!,
        labels: split(draft!.labels),
        areas: split(draft!.areas),
        outputs: draft!.outputs.split("\n").map((x) => x.trim()).filter(Boolean),
        rev: task!.rev,
      });
      setDirty(false);
      setMsg(null);
      await load();
      data.reload();
      ctx.reload();
    } catch (e) {
      setMsg(e instanceof ApiError && e.status === 409 ? "競合: 他で更新されています。破棄して読み直してください。" : String((e as Error).message));
    }
  }

  async function toggleChecked() {
    try {
      await api.patchTask(id, { checked: !task!.checkedAt, rev: task!.rev });
      await load();
      data.reload();
      ctx.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function addRel(type: RelationType, target: string, note?: string) {
    try {
      await api.addRelation(id, { type, target, note });
      setRelTarget("");
      setMsg(null);
      await load();
      data.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function removeRel(e: GraphEdge) {
    await api.removeRelation(id, { type: e.type as RelationType, target: e.to });
    await load();
    data.reload();
  }


  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/20" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col bg-white shadow-xl dark:bg-slate-900"
      >
        <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <Id id={task.id} />
          <span className="text-sm text-slate-400">
            rev {task.rev} · {task.updatedBy ?? "?"}
          </span>
          <div className="ml-auto flex gap-2">
            {dirty && (
              <Button variant="ghost" onClick={() => (setDirty(false), setDraft(toDraft(task)), void load())}>
                破棄
              </Button>
            )}
            <Button variant="primary" disabled={!dirty} onClick={save}>
              保存
            </Button>
            <Button variant="ghost" onClick={onClose}>
              ✕
            </Button>
          </div>
        </div>
        {msg && <div className="bg-amber-50 px-5 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">{msg}</div>}

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          <input className={`${inputCls} text-lg font-semibold`} value={draft.title} onChange={(e) => set("title", e.target.value)} />

          <div className="grid grid-cols-[1fr_2fr] items-end gap-3">
            <Field label="ステータス">
              <select className={inputCls} value={draft.status} onChange={(e) => set("status", e.target.value)}>
                {ctx.info.project.statuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <dl className="grid grid-cols-3 gap-2 pb-1.5 text-sm" title="ステータスを変えたときに pcube が記録する日時">
              <div>
                <dt className="text-slate-500">作成</dt>
                <dd>{fmtTime(task.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">作業中にした</dt>
                <dd>{fmtTime(task.startedAt) || "—"}</dd>
              </div>
              <div>
                <dt className="text-slate-500">完了にした</dt>
                <dd className="flex items-center gap-1.5">
                  {fmtTime(task.doneAt) || "—"}
                  {task.doneAt && (
                    <button
                      onClick={() => void toggleChecked()}
                      title={task.checkedAt ? `済み ${fmtTime(task.checkedAt)}（クリックで外す）` : "クリックで済みにする"}
                      className="transition hover:scale-125"
                    >
                      <DoneMark checked={!!task.checkedAt} />
                    </button>
                  )}
                </dd>
              </div>
            </dl>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="ラベル (カンマ区切り)">
              <input className={inputCls} value={draft.labels} onChange={(e) => set("labels", e.target.value)} />
            </Field>
            <Field label="影響領域 areas (カンマ区切り)">
              <input className={`${inputCls} font-mono`} value={draft.areas} onChange={(e) => set("areas", e.target.value)} />
            </Field>
          </div>
          <Field label="成果物（PR / MR の URL、ドキュメントのパス。1行に1つ）">
            <textarea rows={2} className={`${inputCls} font-mono`} value={draft.outputs} onChange={(e) => set("outputs", e.target.value)} />
          </Field>
          <Field label="本文 (Markdown)">
            <textarea rows={6} className={`${inputCls} font-mono`} value={draft.body} onChange={(e) => set("body", e.target.value)} />
          </Field>

          <Section title="関係（明示）">
            {graph.outgoing.length + graph.incoming.length === 0 && <Empty>明示的な関係はありません</Empty>}
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {graph.outgoing.map((e) => (
                <li key={`o-${e.type}-${e.to}`} className="flex items-center gap-2 py-1.5">
                  <Badge tone="indigo">{RELATION_TYPES[e.type as RelationType]?.label ?? e.type}</Badge>
                  <Id id={short(e.to)} onClick={() => open(e.to)} />
                  <span className="truncate">{title(e.to)}</span>
                  <Origin e={e} />
                  {e.origin !== "index" && (
                    <button className="ml-auto text-sm text-slate-400 hover:text-rose-600" onClick={() => removeRel(e)}>
                      削除
                    </button>
                  )}
                </li>
              ))}
              {graph.incoming.map((e) => (
                <li key={`i-${e.type}-${e.from}`} className="flex items-center gap-2 py-1.5">
                  <Badge tone="violet">{RELATION_TYPES[e.type as RelationType]?.inverse ?? e.type}</Badge>
                  <Id id={short(e.from)} onClick={() => open(e.from)} />
                  <span className="truncate">{title(e.from)}</span>
                  <Origin e={e} />
                </li>
              ))}
            </ul>
            <div className="flex gap-2 pt-1">
              <select className={`${inputCls} !w-40 shrink-0`} value={relType} onChange={(e) => setRelType(e.target.value as RelationType)}>
                {relationTypes.map((t) => (
                  <option key={t} value={t}>
                    {RELATION_TYPES[t].label}
                  </option>
                ))}
              </select>
              <input
                className={`${inputCls} font-mono`}
                list="pcube-rel-targets"
                placeholder="T004 / <要望ID> / <要望ID>/T004"
                value={relTarget}
                onChange={(e) => setRelTarget(e.target.value)}
              />
              <datalist id="pcube-rel-targets">
                {data.tasks
                  .filter((t) => t.ref !== id)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                {ctx.requests
                  .filter((p) => p.request.id !== rid)
                  .map((p) => (
                    <option key={p.request.id} value={p.request.id}>
                      {p.request.title}
                    </option>
                  ))}
              </datalist>
              <Button className="shrink-0 whitespace-nowrap" disabled={!relTarget} onClick={() => addRel(relType, relTarget)}>
                追加
              </Button>
            </div>
          </Section>

          <Section title="関係しそう（暗黙: 領域・内容の近さ）">
            {graph.implicit.length === 0 ? (
              <Empty>候補はありません</Empty>
            ) : (
              <ul className="space-y-1.5">
                {graph.implicit.map((r) => (
                  <li key={r.ref} className="flex items-start gap-2">
                    <span className="w-12 pt-0.5 text-right font-mono text-sm text-slate-400">{r.score.toFixed(2)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Id id={short(r.ref)} onClick={() => open(r.ref)} />
                        <span className="truncate">{r.title}</span>
                      </div>
                      <p className="text-sm text-slate-500">{r.reasons.join(" / ")}</p>
                    </div>
                    <Button variant="ghost" className="text-sm" onClick={() => addRel("relates_to", r.ref, r.reasons.join(" / "))}>
                      ＋関連付け
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="影響範囲（推移的）">
            {graph.impactScope.length === 0 ? (
              <Empty>このタスクの変更が波及する項目はありません</Empty>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {graph.impactScope.map((x) => (
                  <button key={x} onClick={() => open(x)} className="rounded bg-amber-50 px-2 py-0.5 text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900">
                    <span className="font-mono text-sm">{short(x)}</span> {title(x)}
                  </button>
                ))}
              </div>
            )}
          </Section>

          <p className="font-mono text-sm text-slate-400">
            {ctx.info.dataDir}/requests/{rid}/tasks/{task.id}.md
          </p>
        </div>
      </aside>
    </div>
  );
}

function Origin({ e }: { e: GraphEdge }) {
  if (e.origin === "human") return null;
  const label = e.origin === "index" ? "構造" : e.origin === "ai" ? "AI" : "preflight";
  return (
    <Badge tone={e.origin === "index" ? "slate" : "amber"} title={e.note}>
      {label}
      {e.weight !== undefined && ` ${Math.round(e.weight * 100)}%`}
    </Badge>
  );
}
