import { createFileRoute, Link } from "@tanstack/react-router";
import { fetchDefinitions, type DefinitionListing } from "../../lib/api.ts";
import { useLoad } from "../../lib/useLoad.ts";
import { linkCls, primaryCls } from "../../components/styles.ts";

/** /observer: このプロジェクトの観測の定義の一覧（登録・詳細への導線）。observer の API だけを読む */
export const Route = createFileRoute("/observer/")({ component: DefinitionList });

function DefinitionList() {
  const load = useLoad<DefinitionListing>(fetchDefinitions);
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-5 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">観測</h1>
        <Link to="/observer/new" className={primaryCls}>
          ＋ 観測を登録
        </Link>
      </div>
      {load.kind === "loading" && <p className="text-slate-500">読み込み中…</p>}
      {load.kind === "error" && (
        <p role="alert" className="text-rose-600">
          観測の定義を読めませんでした: {load.message}
        </p>
      )}
      {load.kind === "ok" && (
        <>
          {load.value.unreadable.map((u) => (
            <p key={u.file} role="alert" className="text-amber-700 dark:text-amber-400">
              ⚠ 読めないファイル {u.file}: {u.reason}
            </p>
          ))}
          {load.value.definitions.length === 0 ? (
            <p className="text-slate-500">まだ観測の定義がありません。</p>
          ) : (
            <table className="w-full text-left">
              <thead className="text-sm text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="py-1 pr-3 font-normal">タイトル</th>
                  <th className="py-1 pr-3 font-normal">カテゴリ</th>
                  <th className="py-1 pr-3 font-normal">測定・手順</th>
                  <th className="py-1 font-normal">版</th>
                </tr>
              </thead>
              <tbody>
                {load.value.definitions.map((d) => (
                  <tr key={d.id} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="py-2 pr-3">
                      <Link to="/observer/$id" params={{ id: d.id }} className={linkCls}>
                        {d.title}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">{d.category}</td>
                    <td className="py-2 pr-3">
                      {d.measures.length}・{d.procedures.length}
                    </td>
                    <td className="py-2">v{d.rev}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
