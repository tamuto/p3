import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { TASK_STATUS_LABEL, type ArchivedTaskList } from "../../../../shared/types.ts";
import { Empty } from "../../../components/ui.tsx";
import { api } from "../../../lib/api.ts";
import { useAppCtx } from "../../../lib/appCtx.ts";
import { fmtTime } from "../../../lib/format.ts";
import { latestOnly, STALE } from "../../../lib/latest.ts";
import { useRequestData } from "../../../lib/requestData.tsx";

/**
 * アーカイブしたタスクの一覧（閲覧専用）。API の archived-tasks だけを読み、通常のタスクの配列・完了数には足さない。
 * 行を押すと閲覧専用の詳細（?archived=T003）を開く。タブを開くたび・外の変更・再読み込みで取り直す。
 */
export const Route = createFileRoute("/requests/$requestId/archive")({
  component: ArchivePage,
});

function ArchivePage() {
  const ctx = useAppCtx();
  const { request } = useRequestData();
  const navigate = useNavigate();
  const [list, setList] = useState<ArchivedTaskList>();
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(latestOnly());

  const load = async () => {
    try {
      const r = await latest.current.run(() => api.archivedTasks(request.id));
      if (r === STALE) return;
      setList(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id, ctx.tick]);

  const open = (id: string) => void navigate({ to: ".", search: (prev) => ({ ...prev, archived: id, task: undefined }) });

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-8">
      <p className="text-sm text-slate-500">
        アーカイブしたタスクを読むだけの一覧です。進捗・要望の対応済の判定・新しいレビューとリリースノートの材料には入りません。状態・最終更新はアーカイブする前の最後の値です。
      </p>
      {error && (
        <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          アーカイブの一覧を読み込めませんでした{list ? "（表示は前の内容のまま）" : ""}: {error}{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            もう一度読み込む
          </button>
        </p>
      )}
      {!list ? (
        !error && <p className="text-slate-500">読み込み中…</p>
      ) : (
        <>
          {list.errors.length > 0 && (
            <div role="status" className="rounded-md bg-rose-50 px-3 py-2 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
              <p>読めないアーカイブのファイルが {list.errors.length} 件あります（一覧には出していません）:</p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {list.errors.map((e) => (
                  <li key={e.id} className="break-all">
                    <span className="font-mono">{e.id}</span>: {e.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {list.tasks.length === 0 ? (
            <Empty>アーカイブしたタスクはありません</Empty>
          ) : (
            <ul aria-label="アーカイブしたタスク" className="divide-y divide-slate-100 border-y border-slate-200 dark:divide-slate-800/60 dark:border-slate-800">
              {list.tasks.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => open(t.id)}
                    className="flex w-full min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5 text-left hover:text-indigo-600"
                  >
                    <span className="shrink-0 font-mono text-sm text-slate-500 dark:text-slate-400">{t.id}</span>
                    <span className="min-w-0 flex-1 break-words">{t.title}</span>
                    <span className="text-sm whitespace-nowrap text-slate-500">
                      {TASK_STATUS_LABEL[t.status]} · 最終更新 {fmtTime(t.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
