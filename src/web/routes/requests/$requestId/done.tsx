import { createFileRoute } from "@tanstack/react-router";
import { DoneMark } from "../../../components/Marks.tsx";
import { Outputs } from "../../../components/Outputs.tsx";
import { Button, Empty, Id } from "../../../components/ui.tsx";
import { api } from "../../../lib/api.ts";
import { useAppCtx } from "../../../lib/appCtx.ts";
import { fmtTime } from "../../../lib/format.ts";
import { useRequestData } from "../../../lib/requestData.tsx";

/**
 * 対応済みの一覧: 人が「済み」にしたタスク（タスクボードからは消える）。新しい順。
 * 成果物と並べて見られるので、リリースノートの下書きの材料にもなる。
 */
export const Route = createFileRoute("/requests/$requestId/done")({
  component: DonePage,
});

function DonePage() {
  const ctx = useAppCtx();
  const { tasks, reload } = useRequestData();
  const items = tasks.filter((t) => t.checkedAt).sort((a, b) => b.checkedAt!.localeCompare(a.checkedAt!));

  if (!items.length) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <Empty>済みにしたタスクはまだありません。タスクボードの完了欄で「✓ 済み」を押すとここに移ります。</Empty>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <table className="w-full">
        <thead className="text-left text-sm text-slate-500">
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
              <td className="py-2.5 text-sm text-slate-500">{fmtTime(t.checkedAt)}</td>
              <td className="py-2.5">
                <button onClick={() => ctx.open(t.ref)} className="flex items-start gap-2 text-left hover:text-indigo-600">
                  <span className="mt-1.5">
                    <DoneMark checked />
                  </span>
                  <Id id={t.id} />
                  <span>{t.title}</span>
                </button>
              </td>
              <td className="py-1">{t.outputs.length ? <Outputs outputs={t.outputs} /> : <span className="text-sm text-slate-400">—</span>}</td>
              <td className="py-2 text-right">
                <Button
                  variant="ghost"
                  title="タスクボードの完了欄に戻す"
                  onClick={async () => {
                    await api.patchTask(t.ref, { checked: false, rev: t.rev });
                    reload();
                    ctx.reload();
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
