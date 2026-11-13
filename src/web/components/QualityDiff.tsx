import { useEffect, useState } from "react";
import type { TaskQualityDiffItem } from "../../shared/quality.ts";
import type { Task } from "../../shared/types.ts";
import { api, failureOf } from "../lib/api.ts";
import { Button } from "./ui.tsx";

const LABEL: Record<TaskQualityDiffItem["kind"], string> = { add: "足す", change: "品質基準が変わった", remove: "消す", exempt: "除外になった", edited: "タスクで文を直した" };

/**
 * タスク詳細の「品質基準との差分」。プロジェクトの品質基準を変えてもタスクは書き換えないので、差分（足す・変わった・消す・除外・
 * タスクで直した）を見せ、選んだものだけを取り込む（変わった条件の証拠は再確認が必要になる）。差分が無ければ何も出さない
 */
export function QualityDiffPanel({ task, disabled, onSaved }: { task: Task; disabled?: boolean; onSaved: (checkCleared?: string) => void }) {
  const [diff, setDiff] = useState<TaskQualityDiffItem[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = `${task.request}/${task.id}`;
  useEffect(() => {
    let live = true;
    api.taskQualityDiff(ref).then(
      (r) => {
        if (!live) return;
        setDiff(r.diff);
        setPicked(new Set(r.diff.filter((d) => d.kind !== "edited").map((d) => `${d.kind}:${d.quality}`)));
      },
      () => live && setDiff([]),
    );
    return () => {
      live = false;
    };
  }, [ref, task.rev]);
  if (!diff.length) return null;
  const importable = diff.filter((d) => d.kind !== "edited");

  async function apply() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.importTaskQuality(ref, [...picked], task.rev);
      onSaved(r.checkCleared);
    } catch (e) {
      setMsg(failureOf(e) === "rev_conflict" ? "取り込む前にタスクが他で更新されました。最新を読み直してからやり直してください" : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="品質基準との差分" className="space-y-2 rounded-lg bg-sky-50 p-3 text-base dark:bg-sky-950/50">
      <p className="font-medium">品質基準との差分（プロジェクトの品質基準を変えても、タスクは自動では変わりません）</p>
      <ul className="space-y-1">
        {diff.map((d) => {
          const key = `${d.kind}:${d.quality}`;
          return (
            <li key={key} className="flex min-w-0 items-start gap-2">
              {d.kind !== "edited" ? (
                <input
                  type="checkbox"
                  aria-label={`${d.quality} を取り込む（${LABEL[d.kind]}）`}
                  checked={picked.has(key)}
                  disabled={busy || disabled}
                  onChange={(e) => setPicked((p) => (e.target.checked ? new Set([...p, key]) : new Set([...p].filter((x) => x !== key))))}
                />
              ) : (
                <span className="w-4 shrink-0" />
              )}
              <span className="min-w-0 break-words">
                <span className="font-mono">{d.quality}</span> {LABEL[d.kind]}
                {d.criterion ? `（${d.criterion}）` : ""}
                {d.text ? `: ${d.text}` : ""}
                {d.reason ? <span className="block text-slate-500">{d.reason}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {!task.repo && <p className="text-slate-500">作業先なしのタスクには、足す案を出しません。</p>}
      {importable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button className="text-base" disabled={busy || disabled || !picked.size} onClick={() => void apply()}>
            選んだ差分を取り込む
          </Button>
          <span className="text-slate-500">変わった条件の証拠は「再確認が必要」になります。済みの後なら済みが外れます。</span>
        </div>
      )}
      {msg && <p role="alert" className="break-words text-rose-600">{msg}</p>}
    </section>
  );
}
