import { useEffect, useRef, useState } from "react";
import { BLOCK_LIMITS, blockWarnings, type BlockHistoryEntry, type BlockOp } from "../../shared/taskBlock.ts";
import type { Task } from "../../shared/types.ts";
import { api, failureOf } from "../lib/api.ts";
import { fmtTime } from "../lib/format.ts";
import { Button, Field, inputCls } from "./ui.tsx";

/**
 * タスク詳細の上部の「止まっている理由」（shared/taskBlock.ts の規則）。作業中なら付ける・直す・解除でき、作業中でなければ付けられない
 * 理由を出す（停止が残っていれば警告して解除へ）。保存は編集を始めたときの rev で送り、他で変わっていれば入力を残して知らせる。
 * readOnly: アーカイブ（今の値と履歴を読むだけ）
 */

type Form = { kind: "set"; baseRev: number; reason: string; decision: string; baseReason: string; baseDecision: string } | { kind: "clear"; baseRev: number; resolution: string };

const formDirty = (f: Form | null) => !!f && (f.kind === "set" ? f.reason !== f.baseReason || f.decision !== f.baseDecision : !!f.resolution.trim());

export function TaskBlockPanel({
  task,
  readOnly = false,
  disabled = false,
  onSaved,
  onDirty,
}: {
  task: Task;
  readOnly?: boolean;
  disabled?: boolean;
  onSaved?: () => void;
  onDirty?: (dirty: boolean) => void;
}) {
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = formDirty(form);
  const opener = useRef<HTMLButtonElement | null>(null);
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);
  useEffect(() => {
    setForm(null);
    setError(null);
    setConflict(false);
  }, [task.request, task.id]);
  useEffect(() => {
    if (form) first.current?.focus();
    // フォームを開いたときだけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.kind]);

  const b = task.block;
  const warnings = blockWarnings(task);
  const external = !!form && form.baseRev !== task.rev;
  const open = (f: Form, el: HTMLButtonElement) => {
    opener.current = el;
    setForm(f);
    setError(null);
    setConflict(false);
  };
  const close = () => {
    setForm(null);
    setError(null);
    setConflict(false);
    opener.current?.focus();
  };

  async function save() {
    if (!form || busy) return;
    const op: BlockOp = form.kind === "set" ? { op: "set", reason: form.reason, ...(form.decision.trim() ? { decision: form.decision } : {}) } : { op: "clear", resolution: form.resolution };
    setBusy(true);
    try {
      await api.patchTask(`${task.request}/${task.id}`, { blockOp: op, rev: form.baseRev });
      setForm(null);
      setError(null);
      setConflict(false);
      onSaved?.();
      opener.current?.focus();
    } catch (e) {
      if (failureOf(e) === "rev_conflict") {
        setConflict(true);
        setError("保存する前に他で更新されました。入力は残してあります。最新の内容を確かめてから「最新に合わせる」で保存し直せます");
      } else setError(`保存できませんでした（入力は残してあります）: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const invalid = !!form && (form.kind === "set" ? !form.reason.trim() || form.reason.length > BLOCK_LIMITS.reason || form.decision.length > BLOCK_LIMITS.decision : !form.resolution.trim() || form.resolution.length > BLOCK_LIMITS.resolution);

  return (
    <div className="space-y-2">
      {b && (
        <div role="status" aria-label="止まっています" className="space-y-1 rounded-lg bg-amber-50 px-4 py-3 text-amber-950 ring-1 ring-amber-300 dark:bg-amber-950/60 dark:text-amber-100 dark:ring-amber-800">
          <p className="font-semibold">⏸ 停止中</p>
          <p className="break-words whitespace-pre-wrap">
            <span className="font-medium">理由: </span>
            {b.reason}
          </p>
          <p className="text-base">
            いつから: {fmtTime(b.since)}
            {b.updatedBy ? `・記録: ${b.updatedBy}` : ""}
            {b.updatedAt !== b.since ? `・最終更新 ${fmtTime(b.updatedAt)}` : ""}
          </p>
          {b.decision && (
            <p className="break-words whitespace-pre-wrap">
              <span className="font-medium">決めてほしいこと: </span>
              {b.decision}
            </p>
          )}
        </div>
      )}
      {warnings.map((w) => (
        <p key={w} role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-base break-words text-rose-800 dark:bg-rose-950 dark:text-rose-300">
          {w}
        </p>
      ))}
      {!readOnly && !form && (
        <div className="flex flex-wrap items-center gap-2">
          {task.status === "doing" && !b && (
            <Button type="button" className="text-base" disabled={disabled || !!task.blockProblems?.length} onClick={(e) => open({ kind: "set", baseRev: task.rev, reason: "", decision: "", baseReason: "", baseDecision: "" }, e.currentTarget)}>
              停止理由を付ける
            </Button>
          )}
          {b && task.status === "doing" && (
            <Button
              type="button"
              className="text-base"
              disabled={disabled || !!task.blockProblems?.length}
              onClick={(e) => open({ kind: "set", baseRev: task.rev, reason: b.reason, decision: b.decision ?? "", baseReason: b.reason, baseDecision: b.decision ?? "" }, e.currentTarget)}
            >
              停止内容を編集
            </Button>
          )}
          {b && (
            <Button type="button" className="text-base" disabled={disabled || !!task.blockProblems?.length} onClick={(e) => open({ kind: "clear", baseRev: task.rev, resolution: "" }, e.currentTarget)}>
              停止を解除
            </Button>
          )}
          {task.status !== "doing" && !b && <p className="text-base text-slate-500 dark:text-slate-400">停止理由は作業中のタスクだけに付けられます。</p>}
        </div>
      )}
      {form && (
        <section aria-label={form.kind === "set" ? "停止理由" : "停止の解除"} className="space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
          {form.kind === "set" ? (
            <>
              <Field label="止まっている理由（必須）" hint={`何で進められないか。${BLOCK_LIMITS.reason} 文字まで（止まった時刻は直しても変わりません）`}>
                <textarea ref={first} rows={3} className={inputCls} value={form.reason} disabled={busy} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
              </Field>
              <Field label="決めてほしいこと（任意）" hint={`人に判断してほしい具体的なこと。${BLOCK_LIMITS.decision} 文字まで`}>
                <textarea rows={2} className={inputCls} value={form.decision} disabled={busy} onChange={(e) => setForm({ ...form, decision: e.target.value })} />
              </Field>
            </>
          ) : (
            <>
              <Field label="回答・解決の内容（必須）" hint={`${BLOCK_LIMITS.resolution} 文字まで`}>
                <textarea ref={first} rows={3} className={inputCls} value={form.resolution} disabled={busy} onChange={(e) => setForm({ ...form, resolution: e.target.value })} />
              </Field>
              <p className="text-base text-slate-500">停止を解除しても状態は作業中のままです。作業は自動で再開しません（AI には再開を頼んでください）。</p>
            </>
          )}
          {external && !conflict && <p role="status" className="text-base text-amber-700 dark:text-amber-400">編集中に他で更新されました（rev {task.rev}）。このまま保存すると競合になります。</p>}
          {error && (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-base text-rose-600">
              <span className="min-w-0 break-words">{error}</span>
              {conflict && (
                <Button type="button" className="text-base" onClick={() => (setForm({ ...form, baseRev: task.rev }), setConflict(false), setError(null))}>
                  最新に合わせる
                </Button>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="primary" disabled={busy || invalid || conflict || (form.kind === "set" && !dirty)} onClick={() => void save()}>
              {busy ? "保存中…" : form.kind === "set" ? "停止理由を保存" : "記録して停止を解除"}
            </Button>
            <Button type="button" disabled={busy} onClick={close}>
              取消
            </Button>
          </div>
        </section>
      )}
      {!!task.blockHistory?.length && <BlockHistory history={task.blockHistory} />}
    </div>
  );
}

const ACTION = { set: "付けた", update: "直した", clear: "解除した" } as const;

function BlockHistory({ history }: { history: BlockHistoryEntry[] }) {
  return (
    <details className="text-base">
      <summary className="cursor-pointer text-slate-600 dark:text-slate-300">停止の履歴（{history.length} 件）</summary>
      <ol className="mt-2 space-y-2 border-l-2 border-slate-200 pl-3 dark:border-slate-700">
        {[...history].reverse().map((h, i) => (
          <li key={`${h.at}-${i}`} className="space-y-0.5">
            <p className="font-medium">
              {fmtTime(h.at)} {ACTION[h.action]}
              {h.by ? `・${h.by}` : ""}
            </p>
            {h.action === "update" && h.before && <p className="break-words text-slate-500">前の理由: {h.before.reason}</p>}
            {(h.after ?? h.before) && <p className="break-words whitespace-pre-wrap">理由: {(h.after ?? h.before)!.reason}</p>}
            {h.after?.decision && <p className="break-words whitespace-pre-wrap">決めてほしいこと: {h.after.decision}</p>}
            {h.resolution && <p className="break-words whitespace-pre-wrap">回答・解決: {h.resolution}</p>}
          </li>
        ))}
      </ol>
    </details>
  );
}
