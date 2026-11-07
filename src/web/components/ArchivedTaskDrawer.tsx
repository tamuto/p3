import { useEffect, useRef, useState, type ReactNode } from "react";
import { normalizeTaskId } from "../../shared/refs.ts";
import { relationRole, TASK_STATUS_LABEL, type ArchivedTask } from "../../shared/types.ts";
import type { AppCtx } from "../lib/appCtx.ts";
import { api, archiveUnreadable, failureOf } from "../lib/api.ts";
import { fmtTime } from "../lib/format.ts";
import { latestOnly, STALE } from "../lib/latest.ts";
import { Markdown } from "./Markdown.tsx";
import { Outputs } from "./Outputs.tsx";
import { Badge, Button, Empty, Id, Section } from "./ui.tsx";

/** 読めなかった理由。表示は最後に読めた内容のまま（無言で閉じたり空にしたりしない） */
type Problem = { kind: "missing" | "unreadable" | "failed"; message: string };

/**
 * アーカイブしたタスクの詳細（閲覧専用。?archived=T003）。通常のタスク詳細（TaskDrawer）とは別の部品にし、
 * 保存・状態の変更・済み・作業先・復元の操作は置かない。読むのは API の archived-tasks だけ。
 */
export function ArchivedTaskDrawer({ ctx, rid, id: rawId, onClose }: { ctx: AppCtx; rid: string; id: string; onClose: () => void }) {
  const tid = normalizeTaskId(rawId) ?? rawId;
  const [task, setTask] = useState<ArchivedTask>();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(latestOnly());
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await latest.current.run(() => api.archivedTask(rid, tid));
      if (r === STALE) return;
      setTask(r.task);
      setProblem(null);
    } catch (e) {
      const message = (e as Error).message;
      setProblem(
        failureOf(e) === "not_found"
          ? { kind: "missing", message: `アーカイブに ${tid} はありません（外で移された・消された可能性があります）` }
          : archiveUnreadable(e)
            ? { kind: "unreadable", message: `${tid} のアーカイブのファイルを読めません: ${message}` }
            : { kind: "failed", message: `読み込めませんでした: ${message}` },
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setTask(undefined);
    setProblem(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid, tid]);

  // 外の変更・再読み込みで取り直す
  useEffect(() => {
    if (task || problem) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.tick]);

  // 開いたら閉じるボタンへ、閉じたら開く前の場所へフォーカスを戻す
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => before?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/20" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`アーカイブしたタスク ${tid}（閲覧専用）`}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col bg-white shadow-xl dark:bg-slate-900"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <Id id={tid} />
          <Badge tone="violet">アーカイブ</Badge>
          <Badge>閲覧専用</Badge>
          <div className="ml-auto">
            <Button ref={closeRef} variant="ghost" aria-label="閉じる" onClick={onClose}>
              ✕
            </Button>
          </div>
        </div>
        {problem && (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-amber-50 px-5 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <span className="min-w-0 break-words">
              {problem.message}
              {task ? "（表示は最後に読めた内容です）" : ""}
            </span>
            <button type="button" className="underline" onClick={() => void load()}>
              もう一度読み込む
            </button>
          </div>
        )}
        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {!task ? (
            loading ? <p className="text-slate-500">読み込み中…</p> : !problem && <Empty>表示できる内容がありません</Empty>
          ) : (
            <Body ctx={ctx} task={task} rid={rid} />
          )}
        </div>
      </aside>
    </div>
  );
}

function Body({ ctx, task, rid }: { ctx: AppCtx; task: ArchivedTask; rid: string }) {
  return (
    <>
      <h2 className="text-lg font-semibold break-words">{task.title}</h2>
      <p className="text-sm text-slate-500">
        このタスクはアーカイブされています。進捗・対応済の判定・新しいレビューとリリースノートの材料には入りません。下の状態と最終更新はアーカイブする前の最後の値で、アーカイブした日時ではありません。
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <Item label="アーカイブ前の状態">{TASK_STATUS_LABEL[task.status]}</Item>
        <Item label="作業先">{task.repo ?? "（なし）"}</Item>
        <Item label="最終更新">{`${fmtTime(task.updatedAt)}${task.updatedBy ? ` · ${task.updatedBy}` : ""}`}</Item>
        <Item label="作成">{fmtTime(task.createdAt)}</Item>
        <Item label="作業中にした">{fmtTime(task.startedAt) || "—"}</Item>
        <Item label="完了にした">{fmtTime(task.doneAt) || "—"}</Item>
        {task.checkedAt && <Item label="済みにした">{fmtTime(task.checkedAt)}</Item>}
        {task.labels.length > 0 && <Item label="ラベル">{task.labels.join(", ")}</Item>}
        {task.areas.length > 0 && <Item label="影響領域">{task.areas.join(", ")}</Item>}
      </dl>
      <Section title="本文">{task.body.trim() ? <Markdown text={task.body} /> : <p className="text-sm text-slate-400">ありません</p>}</Section>
      <Section title="変更の記録">{task.record?.trim() ? <Markdown text={task.record} /> : <p className="text-sm text-slate-400">ありません</p>}</Section>
      <Section title="成果物">
        {task.outputs.length || task.repoOutputs?.length ? <Outputs outputs={task.outputs} repoOutputs={task.repoOutputs} /> : <p className="text-sm text-slate-400">ありません</p>}
      </Section>
      <Section title="保存された関係（アーカイブしたときのまま）">
        {task.relations.length === 0 ? (
          <p className="text-sm text-slate-400">ありません</p>
        ) : (
          <ul className="space-y-1">
            {task.relations.map((r) => (
              <li key={`${r.type}-${r.target}`} className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-sm text-slate-500">{relationRole(r.type, "out")}</span>
                <span className="font-mono text-sm">{r.target}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <p className="font-mono text-sm break-all text-slate-400">
        {ctx.info.dataDir}/requests/{rid}/tasks/.archive/{task.id}.md
      </p>
    </>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}
