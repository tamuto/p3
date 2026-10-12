import { useEffect, useRef, useState } from "react";
import { normalizeTaskId } from "../../shared/refs.ts";
import { RELATION_TYPES, relationTypes, type GraphEdge, type RepoOutput, type Neighborhood, type RelationType, type SupersededMark, type Task, TASK_STATUSES, TASK_STATUS_LABEL, type TaskStatus } from "../../shared/types.ts";
import type { AppCtx } from "../lib/appCtx.ts";
import { api, ApiError } from "../lib/api.ts";
import { markFrom, warningText } from "../lib/supersede.ts";
import { fmtTime } from "../lib/format.ts";
import type { RequestData } from "../lib/requestData.tsx";
import { DoneMark } from "./Marks.tsx";
import { Outputs } from "./Outputs.tsx";
import { Badge, Button, Empty, Field, Id, inputCls, Section } from "./ui.tsx";
import { relationItems } from "../lib/relations.ts";
import { NO_REPO, repoChoices, requestWorkstreams, taskRepo } from "../../shared/workTarget.ts";
import { discardDraft, draftOf, editDraft, isDirty, shallowEqual, syncDraft, type Draft as DraftState } from "../lib/draft.ts";
import { latestOnly, STALE } from "../lib/latest.ts";
import { RelationRow } from "./RelationRow.tsx";

type Fields = Pick<Task, "title" | "status" | "body"> & { labels: string; areas: string; outputs: string };

const toDraft = (t: Task): Fields => ({
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
  const [superseded, setSuperseded] = useState<SupersededMark[]>([]);
  // 入力は下書きで持つ（取り直しても編集中は上書きしない。保存は編集を始めたときの rev で。lib/draft.ts）
  const [draft, setDraft] = useState<DraftState<Fields>>();
  /** 外で削除・アーカイブされた（入力は残し、保存しない） */
  const [gone, setGone] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [relType, setRelType] = useState<RelationType>("depends_on");
  const [relTarget, setRelTarget] = useState("");
  const latest = useRef(latestOnly());
  const dirty = !!draft && isDirty(draft, shallowEqual);

  /**
   * 取り直す。fresh: 開いたとき（下書きも作り直す）。
   * own: この画面での入力欄以外の操作（済み・関係）の後。入力欄の項目が編集を始めたときのままなら、自分で上げた rev に合わせる
   */
  const load = async (fresh = false, own = false) => {
    try {
      const r = await latest.current.run(() => api.task(id));
      if (r === STALE) return;
      setTask(r.task);
      setGraph(r.graph);
      setSuperseded(r.superseded);
      setGone(false);
      const server = toDraft(r.task);
      setDraft((d) => {
        if (fresh || !d) return draftOf(server, r.task.rev);
        if (own && shallowEqual(d.base, server)) return { ...d, baseRev: r.task.rev, external: null };
        return syncDraft(d, server, r.task.rev, shallowEqual);
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setGone(true);
      else setMsg(`最新の内容を読み込めませんでした（表示は前の内容のまま）: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    setDraft(undefined);
    setGone(false);
    setMsg(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 外部更新の反映。編集中なら上書きせず知らせる
  useEffect(() => {
    if (task) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.tick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!task || !draft || !graph) return null;
  const fields = draft.value;
  // 共有の参照先があるときだけ、作業先とリポジトリごとの成果物を扱う
  const multi = ctx.info.project.repos.length > 0;

  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setDraft((d) => d && editDraft(d, { ...d.value, [k]: v }));
  /** 同じ要望の中は T003 と短く見せる */
  const short = (ref: string) => (ref.startsWith(`${rid}/`) ? ref.slice(rid.length + 1) : ref);
  const title = (ref: string) => graph.titles[ref] ?? data.tasks.find((t) => t.ref === ref)?.title ?? "";
  const open = (ref: string) => ctx.open(ref);

  async function save() {
    if (gone) return setMsg("このタスクは見つからないので保存しません。入力は残してあります");
    try {
      const res = await api.patchTask(id, {
        ...fields,
        labels: split(fields.labels),
        areas: split(fields.areas),
        outputs: fields.outputs.split("\n").map((x) => x.trim()).filter(Boolean),
        rev: draft!.baseRev,
      });
      setDraft(draftOf(toDraft(res), res.rev));
      // 置き換えられたタスクを作業中にしたときは、保存したうえで知らせる
      const w = warningText(res);
      setMsg(w ? `警告: ${w}` : null);
      await load();
      data.reload();
      ctx.reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setMsg("競合: 他で更新されています。入力は残してあります。「破棄」で最新を表示します。");
        void load();
      } else if (e instanceof ApiError && e.status === 404) setGone(true);
      else setMsg(String((e as Error).message));
    }
  }

  async function toggleChecked() {
    try {
      await api.patchTask(id, { checked: !task!.checkedAt, rev: task!.rev });
      await load(false, true);
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
      await load(false, true);
      data.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function removeRel(e: GraphEdge) {
    await api.removeRelation(id, { type: e.type as RelationType, target: e.to });
    await load(false, true);
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
              <Button variant="ghost" onClick={() => (setDraft((d) => d && discardDraft(d)), setMsg(null), void load())}>
                破棄
              </Button>
            )}
            <Button variant="primary" disabled={!dirty || gone} onClick={save}>
              保存
            </Button>
            <Button variant="ghost" onClick={onClose}>
              ✕
            </Button>
          </div>
        </div>
        {gone && (
          <div role="alert" className="bg-rose-50 px-5 py-2 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
            このタスクは見つかりません（外で削除・アーカイブされました）。保存はしません。入力は残っているので、必要なら写してから閉じてください。
          </div>
        )}
        {dirty && draft.external && (
          <div role="status" className="bg-amber-50 px-5 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            編集中に他で更新されました（rev {draft.external.rev}）。このまま保存すると競合になります。入力を捨てて最新にするには「破棄」。
          </div>
        )}
        {msg && <div className="bg-amber-50 px-5 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">{msg}</div>}
        {superseded.length > 0 && task.status !== "done" && (
          <div className="bg-rose-50 px-5 py-2 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
            このタスクは置き換えられています:{" "}
            {superseded.map((m, i) => (
              <span key={m.from}>
                {i > 0 && " / "}
                {m.from === rid ? (
                  "要望の再評価"
                ) : (
                  <button className="font-mono underline" onClick={() => open(m.from)}>
                    {markFrom(m, rid)}
                  </button>
                )}
                {m.note ? `（${m.note}）` : ""}
              </span>
            ))}
            。着手する前に確かめ、不要ならアーカイブしてください。
          </div>
        )}

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          <input className={`${inputCls} text-lg font-semibold`} value={fields.title} onChange={(e) => set("title", e.target.value)} />

          <div className="grid grid-cols-[1fr_2fr] items-end gap-3">
            <Field label="ステータス">
              <select className={inputCls} value={fields.status} onChange={(e) => set("status", e.target.value as TaskStatus)}>
                {TASK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {TASK_STATUS_LABEL[s]}
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
                <dd>{fmtTime(task.doneAt) || "—"}</dd>
              </div>
            </dl>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="ラベル (カンマ区切り)">
              <input className={inputCls} value={fields.labels} onChange={(e) => set("labels", e.target.value)} />
            </Field>
            <Field label="影響領域 areas (カンマ区切り)">
              <input className={`${inputCls} font-mono`} value={fields.areas} onChange={(e) => set("areas", e.target.value)} />
            </Field>
          </div>
          {task.doneAt && (
            <div className="flex items-center gap-3 rounded-lg bg-emerald-50 px-4 py-2.5 dark:bg-emerald-950/40">
              <DoneMark checked={!!task.checkedAt} />
              <span className="flex-1">{task.checkedAt ? `済み（${fmtTime(task.checkedAt)} に確認）` : "完了しています。成果物を確認したら済みにしてください"}</span>
              <Button variant={task.checkedAt ? "ghost" : "primary"} onClick={() => void toggleChecked()}>
                {task.checkedAt ? "済みを外す" : "済みにする"}
              </Button>
            </div>
          )}

          {multi && <WorkTarget ctx={ctx} data={data} task={task} disabled={gone} onSaved={() => (void load(false, true), data.reload())} onError={setMsg} />}
          <Section title="成果物">
            {task.outputs.length || task.repoOutputs?.length ? (
              // 保存済みのもの（URL はリンク。編集中の内容は下の欄で、保存するとここに出る）
              <Outputs outputs={task.outputs} repoOutputs={task.repoOutputs} />
            ) : (
              <p className="text-sm text-slate-400">まだありません</p>
            )}
            {multi && <RepoOutputsEditor ctx={ctx} task={task} disabled={gone} onSaved={() => (void load(false, true), data.reload())} onError={setMsg} />}
          </Section>
          <Field label="成果物を編集（1行に1つ。PR / MR の URL・文章・ドキュメントのパスを混ぜてよい。http(s) の URL はリンクになる）">
            <textarea rows={3} className={inputCls} value={fields.outputs} onChange={(e) => set("outputs", e.target.value)} />
          </Field>
          <Field label="本文 (Markdown)">
            <textarea rows={6} className={`${inputCls} font-mono`} value={fields.body} onChange={(e) => set("body", e.target.value)} />
          </Field>

          <Section title="関係（明示）">
            {graph.outgoing.length + graph.incoming.length === 0 && <Empty>明示的な関係はありません</Empty>}
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {relationItems(graph.outgoing, graph.incoming, rid).map((r) => (
                <li key={r.key}>
                  <RelationRow
                    role={r.role}
                    tone={r.direction === "out" ? "indigo" : "violet"}
                    refId={r.short}
                    onOpen={() => open(r.ref)}
                    title={title(r.ref)}
                    note={r.edge.origin !== "index" ? r.edge.note : undefined}
                    aside={
                      <>
                        <Origin e={r.edge} />
                        {r.removable && (
                          <button className="text-sm text-slate-400 hover:text-rose-600" onClick={() => removeRel(r.edge)} aria-label={`${r.role} ${r.short} の関係を削除`}>
                            削除
                          </button>
                        )}
                      </>
                    }
                  />
                </li>
              ))}
            </ul>
            <div className="flex gap-2 pt-1">
              <select
                className={`${inputCls} !w-40 shrink-0`}
                value={relType}
                title={RELATION_TYPES[relType].verb}
                onChange={(e) => setRelType(e.target.value as RelationType)}
              >
                {relationTypes.map((t) => (
                  <option key={t} value={t} title={RELATION_TYPES[t].verb}>
                    {RELATION_TYPES[t].verb.split("（")[0]}
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
            <p className="text-sm text-slate-500">
              {RELATION_TYPES[relType].verb}。このタスクには「{RELATION_TYPES[relType].label} {relTarget || "相手"}」、相手には「{RELATION_TYPES[relType].inverse} {short(id)}」と出ます。
            </p>
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

/** 作業先（選ぶとすぐ保存。足りないブランチはサーバが割り当てる）とそのブランチ */
function WorkTarget({
  ctx,
  data,
  task,
  disabled,
  onSaved,
  onError,
}: {
  ctx: AppCtx;
  data: RequestData;
  task: Task;
  disabled: boolean;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const current = taskRepo(task, ctx.info.project) ?? null;
  const branch = current ? requestWorkstreams(data.request, ctx.info.project)[current] : undefined;
  const change = async (value: string) => {
    try {
      await api.patchTask(`${task.request}/${task.id}`, { repo: value === NO_REPO ? null : value, rev: task.rev });
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="作業先（すぐ保存）">
        <select className={`${inputCls} !w-56`} value={current ?? NO_REPO} disabled={disabled} onChange={(e) => void change(e.target.value)}>
          {repoChoices(ctx.info.project, current).map((c) => (
            <option key={c.value} value={c.value} disabled={c.invalid}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="pb-2 text-sm text-slate-500">
        {current ? (branch ? <>ブランチ <code className="font-mono break-all">{branch.branch}</code></> : "ブランチなし（git でないフォルダ・まだ割り当てていない）") : "作業先なし（調査・人の判断など）"}
        {task.repo === undefined && current && "（以前のタスク: 主リポジトリ）"}
      </p>
    </div>
  );
}

/** リポジトリごとの成果物を足す・外す（すぐ保存） */
function RepoOutputsEditor({ ctx, task, disabled, onSaved, onError }: { ctx: AppCtx; task: Task; disabled: boolean; onSaved: () => void; onError: (m: string) => void }) {
  const choices = repoChoices(ctx.info.project, null).filter((c) => c.value !== NO_REPO);
  const [repo, setRepo] = useState(taskRepo(task, ctx.info.project) ?? choices[0]?.value ?? "");
  const [value, setValue] = useState("");
  const save = async (next: RepoOutput[]) => {
    try {
      await api.patchTask(`${task.request}/${task.id}`, { repoOutputs: next, rev: task.rev });
      setValue("");
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const list = task.repoOutputs ?? [];
  return (
    <div className="mt-2 space-y-2">
      {list.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="リポジトリごとの成果物">
          {list.map((o, i) => (
            <li key={`${i}:${o.repo}:${o.output}`} className="inline-flex max-w-full items-center gap-1 rounded bg-slate-100 py-0.5 pr-0.5 pl-2 text-sm dark:bg-slate-800">
              <span className="min-w-0 break-all">
                {o.repo}: {o.output}
              </span>
              <button
                type="button"
                disabled={disabled}
                aria-label={`${o.repo} の成果物「${o.output}」を外す`}
                onClick={() => void save(list.filter((_, j) => j !== i))}
                className="shrink-0 rounded px-1 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <select className={`${inputCls} !w-40`} value={repo} disabled={disabled} aria-label="成果物のリポジトリ" onChange={(e) => setRepo(e.target.value)}>
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          className={`${inputCls} min-w-0 flex-1`}
          value={value}
          disabled={disabled}
          placeholder="リポジトリごとの成果物（PR の URL など）"
          aria-label="リポジトリごとの成果物"
          onChange={(e) => setValue(e.target.value)}
        />
        <Button disabled={disabled || !repo || !value.trim()} onClick={() => void save([...list, { repo, output: value.trim() }])}>
          足す
        </Button>
      </div>
    </div>
  );
}
