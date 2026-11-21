import { Alert, Empty, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link } from "@tanstack/react-router";
import { fetchDefinitions, type DefinitionListing } from "../../lib/api.ts";
import { useLoad } from "../../lib/useLoad.ts";

/** /observer: このプロジェクトの観測の定義の一覧（詳細と準備の一覧への導線。登録は共通のツールバーの「新しい観測」から）。observer の API だけを読む */
export const Route = createFileRoute("/observer/")({ component: DefinitionList });

function DefinitionList() {
  const load = useLoad<DefinitionListing>(fetchDefinitions);
  return (
    <div className="w-full space-y-2 px-4 py-3 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">観測</h1>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Link to="/observer/candidates" className={linkCls}>
            AI に観測の候補を頼む
          </Link>
          <Link to="/observer/preparations" className={linkCls}>
            準備（観測の前後で状態を作る・戻すもの）
          </Link>
        </div>
      </div>
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>観測の定義を読めませんでした: {load.message}</Alert>}
      {load.kind === "ok" && (
        <>
          {load.value.unreadable.map((u) => (
            <Alert key={u.file} warn>⚠ 読めないファイル {u.file}: {u.reason}</Alert>
          ))}
          {load.value.definitions.length === 0 ? (
            <Empty>まだ観測の定義がありません。</Empty>
          ) : (
            <table className="w-full text-left">
              <thead className="text-slate-600 dark:text-slate-400">
                <tr>
                  <th className="py-1 pr-3 font-normal">タイトル</th>
                  <th className="py-1 pr-3 font-normal">カテゴリ</th>
                  <th className="py-1 pr-3 font-normal">測定・手順</th>
                  <th className="py-1 font-normal">版・状態</th>
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
                    <td className="py-2">
                      v{d.rev}
                      {d.ended ? "・終了" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <p className="pt-2 text-slate-600 dark:text-slate-400">観測は、今の期待（仕様）が実際の環境・データ・使い方で成り立っているかを確かめる記録です。テストを流す仕組み（CI）ではありません。</p>
    </div>
  );
}
