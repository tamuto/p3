import { Alert, buttonCls, Empty, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link } from "@tanstack/react-router";
import { SLOT_LABEL, SLOTS } from "../../../../shared/preparation.ts";
import { fetchPreparations } from "../../../lib/api.ts";
import { useLoad } from "../../../lib/useLoad.ts";

/** /observer/preparations: このプロジェクトの準備の一覧（観測の前後で状態を作る・戻すもの。観測から名前か ID で参照する） */
export const Route = createFileRoute("/observer/preparations/")({ component: PreparationList });

function PreparationList() {
  const load = useLoad(fetchPreparations);
  return (
    <div className="w-full space-y-2 px-4 py-3 sm:px-6 lg:px-8">
      <Link to="/observer" className={linkCls}>
        ← 観測の一覧
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">準備</h1>
        <Link to="/observer/preparations/new" className={buttonCls("primary")}>
          ＋ 新しい準備
        </Link>
      </div>
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>準備を読めませんでした: {load.message}</Alert>}
      {load.kind === "ok" && (
        <>
          {load.value.unreadable.map((u) => (
            <Alert key={u.file} warn>⚠ 読めないファイル {u.file}: {u.reason}</Alert>
          ))}
          {load.value.items.length === 0 ? (
            <Empty>まだ準備がありません。</Empty>
          ) : (
            <table className="w-full text-left">
              <thead className="text-fg-3">
                <tr>
                  <th className="py-1 pr-3 font-normal">名前</th>
                  <th className="py-1 pr-3 font-normal">中身</th>
                  <th className="py-1 pr-3 font-normal">占有</th>
                  <th className="py-1 font-normal">版</th>
                </tr>
              </thead>
              <tbody>
                {load.value.items.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <td className="py-2 pr-3">
                      <Link to="/observer/preparations/$pid" params={{ pid: p.id }} className={linkCls}>
                        {p.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">{SLOTS.filter((s) => p[s]).map((s) => SLOT_LABEL[s]).join("・") || "なし"}</td>
                    <td className="py-2 pr-3">{p.exclusive.join("・") || "なし"}</td>
                    <td className="py-2">v{p.rev}</td>
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
