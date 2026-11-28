import { Alert, Badge, buttonCls, Empty, inputCls, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { formatGuide, formatValue, METRIC_AGGREGATE_LABEL, type KeySummary } from "../../../shared/metric.ts";
import { Sparkline } from "../../components/Sparkline.tsx";
import { observerApi } from "../../lib/api.ts";
import { useLoad } from "../../lib/useLoad.ts";

/** /observer?m=: このプロジェクトの観測の項目（システムの項目と利用者の項目）のカード。m はマイルストーン（値に付いたもので絞り、カードの数と推移も絞った値で出す） */
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
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {load.value.keys.map((k) => (
                <KeyCard key={k.key} k={k} m={m} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** 項目のカード: 名前（詳細へ）・カードに出す数（項目キーの集計の方法）と単位・推移と目安の線・目安・値の件数と最後の日時。判定はしない */
function KeyCard({ k, m }: { k: KeySummary; m?: string }) {
  const u = k.unit ? ` ${k.unit}` : "";
  const guide = formatGuide(k);
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-4">
      <div className="min-w-0">
        <Link to="/observer/$key" params={{ key: k.key }} search={{ m }} className={`${linkCls} font-semibold break-words`}>
          {k.name}
        </Link>
        <div data-aux className="flex flex-wrap items-center gap-2 font-mono text-sm break-all text-fg-4">
          {k.key}
          {k.system && <Badge>システム</Badge>}
        </div>
      </div>
      {k.card === undefined ? (
        <p className="text-fg-4">値なし</p>
      ) : (
        <p className="min-w-0 break-all">
          <span className="text-fg-3">{METRIC_AGGREGATE_LABEL[k.aggregate ?? "last"]} </span>
          <span className="text-3xl font-bold">{formatValue(k.card)}</span>
          {u}
        </p>
      )}
      {k.series && <Sparkline series={k.series} guide={k.guide} unit={k.unit} label={k.name} />}
      {guide && <p className="text-fg-3">目安 {guide}</p>}
      <p data-aux className="mt-auto text-sm text-fg-4">
        値 {k.count} 件{k.latest ? `・最後 ${k.latest.at.slice(0, 10)}` : ""}
      </p>
    </li>
  );
}
