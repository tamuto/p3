import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { DoneMark } from "../../../components/Marks.tsx";
import { Outputs } from "../../../components/Outputs.tsx";
import { Button, Empty, Id } from "../../../components/ui.tsx";
import { runAction } from "../../../lib/action.ts";
import { api } from "../../../lib/api.ts";
import { useAppCtx } from "../../../lib/appCtx.ts";
import { fmtTime } from "../../../lib/format.ts";
import { useRequestData } from "../../../lib/requestData.tsx";
import { byCheckedDesc } from "../../../lib/order.ts";
import { ReviewBadge } from "../../../components/CompletionReview.tsx";

/**
 * 対応済みの一覧: 人が「済み」にしたタスク（タスクボードからは消える）。新しい順。
 * 成果物と並べて見られるので、リリースノートの下書きの材料にもなる。
 */
export const Route = createFileRoute("/requests/$requestId/done")({
  component: DonePage,
});

function DonePage() {
  const ctx = useAppCtx();
  const { tasks, reload, review } = useRequestData();
  const items = tasks.filter((t) => t.checkedAt).sort(byCheckedDesc);
  // 見直しが必要（候補）の済みのタスク（API の共通の結果。済みのまま）
  const candidates = items.filter((t) => review?.tasks[t.id]?.state === "candidate").length;
  const [error, setError] = useState<string | null>(null);

  if (!items.length) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <Empty>済みにしたタスクはまだありません。タスクボードの完了欄で「✓ 済み」を押すとここに移ります。</Empty>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      {candidates > 0 && (
        <p role="status" className="mb-4 rounded-lg bg-amber-50 px-4 py-2.5 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          見直しが必要（候補）の済みのタスクが {candidates} 件あります。済みの状態は変えていません。タスクを開いて当時と今の条件を比べてください。
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 text-rose-600">
          {error}
        </p>
      )}
      <table className="w-full">
        <thead className="text-left text-base text-slate-500">
          <tr className="border-b border-slate-200 dark:border-slate-800">
            <th className="w-36 py-2 font-medium">済みにした日</th>
            <th className="py-2 font-medium">タスク</th>
            <th className="w-80 py-2 font-medium">成果物</th>
            <th className="w-28" />
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.id} className="border-b border-slate-100 align-top dark:border-slate-800/60">
              <td data-aux className="py-2.5 text-sm text-slate-500">{fmtTime(t.checkedAt)}</td>
              <td className="py-2.5">
                <button onClick={() => ctx.open(t.ref)} className="flex items-start gap-2 text-left hover:text-indigo-600">
                  <span className="mt-1.5">
                    <DoneMark checked />
                  </span>
                  <Id id={t.id} />
                  <span>{t.title}</span>
                </button>
                {/* 条件の比較（見直しが必要（候補）・記録なし・比較不能。差分なしは出さない） */}
                {review?.tasks[t.id] && review.tasks[t.id].state !== "none" && (
                  <button type="button" onClick={() => ctx.open(t.ref)} className="mt-1 ml-6 text-left" aria-label={`${t.id} の当時と現在の条件を見る`}>
                    <ReviewBadge state={review.tasks[t.id].state} count={review.tasks[t.id].reasons} />
                  </button>
                )}
              </td>
              <td className="py-1">{t.outputs.length || t.repoOutputs?.length ? <Outputs outputs={t.outputs} repoOutputs={t.repoOutputs} /> : <span className="text-base text-slate-500 dark:text-slate-400">—</span>}</td>
              <td className="py-2 text-right">
                <Button
                  variant="ghost"
                  title="タスクボードの完了欄に戻す"
                  onClick={() => {
                    setError(null);
                    // 外で変わっていた（rev が違う）・消えたときは知らせて読み直す
                    runAction(
                      async () => {
                        await api.patchTask(t.ref, { checked: false, rev: t.rev });
                        reload();
                        ctx.reload();
                      },
                      (m) => {
                        setError(`${t.id} の「済み」を外せませんでした: ${m}`);
                        reload();
                      },
                    );
                  }}
                >
                  済みを外す
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
