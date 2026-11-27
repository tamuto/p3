import { Alert, buttonCls, Empty, inputCls, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { formatValue, METRIC_TYPE_LABEL } from "../../../shared/metric.ts";
import { observerApi } from "../../lib/api.ts";
import { useLoad } from "../../lib/useLoad.ts";

/** /observer?m=: このプロジェクトの観測の項目（システムの項目と利用者の項目）と最後の値。m はマイルストーン（値に付いたもので絞る） */
export const Route = createFileRoute("/observer/")({
  component: KeyList,
  validateSearch: (s: Record<string, unknown>): { m?: string } => ({ m: typeof s.m === "string" && s.m ? s.m : undefined }),
});

function KeyList() {
  const { m } = Route.useSearch();
  const navigate = useNavigate();
  const load = useLoad(() => observerApi.keys(m), m ?? "");
  return (
    <div className="w-full space-y-3 px-4 py-3 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">観測</h1>
        <Link to="/observer/new" className={buttonCls("secondary")}>
          ＋ 新しい項目
        </Link>
      </div>
      <p className="text-fg-3">項目キーごとに値を貯めて見せます。値を何で得たかは扱わず、目安と比べた判定もしません。システムの項目は、要望・タスクの操作のときに p3 が記録します。</p>
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>観測の項目を読めませんでした: {load.message}</Alert>}
      {load.kind === "ok" && (
        <>
          {load.value.milestones.length > 0 && (
            <label className="flex max-w-sm flex-col gap-1">
              マイルストーン
              <select className={inputCls} value={m ?? ""} onChange={(e) => void navigate({ to: "/observer", search: { m: e.target.value || undefined } })}>
                <option value="">すべての値</option>
                {load.value.milestones.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
          )}
          {load.value.unreadable.map((u) => (
            <Alert key={u.file} warn>
              ⚠ 読めないファイル {u.file}: {u.reason}
            </Alert>
          ))}
          {load.value.keys.length === 0 ? (
            <Empty>観測の項目がありません。</Empty>
          ) : (
            <table className="w-full text-left">
              <thead className="text-fg-3">
                <tr>
                  <th className="py-1 pr-3 font-normal">項目</th>
                  <th className="py-1 pr-3 font-normal">値の形</th>
                  <th className="py-1 pr-3 font-normal">最後の値</th>
                  <th className="py-1 font-normal">件数</th>
                </tr>
              </thead>
              <tbody>
                {load.value.keys.map((k) => (
                  <tr key={k.key} className="border-t border-line">
                    <td className="py-2 pr-3">
                      <Link to="/observer/$key" params={{ key: k.key }} search={{ m }} className={linkCls}>
                        {k.name}
                      </Link>
                      <div data-aux className="font-mono text-sm break-all text-fg-4">
                        {k.key}
                        {k.system ? "（システム）" : ""}
                      </div>
                    </td>
                    <td className="py-2 pr-3">{METRIC_TYPE_LABEL[k.type]}</td>
                    <td className="py-2 pr-3 break-all">
                      {k.latest ? `${formatValue(k.latest.value)}${k.unit ? ` ${k.unit}` : ""}（${k.latest.at.slice(0, 10)}）` : <span className="text-fg-4">値なし</span>}
                    </td>
                    <td className="py-2">{k.count}</td>
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
