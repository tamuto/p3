import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReleaseMaterial, ReleaseWarning } from "../../../shared/types.ts";
import { RequestStatusBadge } from "../RequestStatus.tsx";
import { Badge, cx, Empty } from "../ui.tsx";

/**
 * マイルストーンに属する要望（収録 / 対象外と理由・変更の記録の数・警告）。収録する要望は開くとタスクの変更の記録（要約の出典）を見られる。
 * 判定はサーバのもの（material）をそのまま出す
 */
export function MaterialView({ material }: { material: ReleaseMaterial }) {
  const [open, setOpen] = useState<string | null>(null);
  const included = material.requests.filter((r) => r.included).length;
  const records = new Map(material.sources.map((s) => [s.request, s.tasks]));
  return (
    <section className="space-y-3" aria-labelledby="rn-material">
      <h3 id="rn-material" className="text-lg font-semibold">
        このマイルストーンの要望 <span className="text-base font-normal text-slate-500">収録 {included} 件 / 全 {material.requests.length} 件</span>
      </h3>
      <Warnings items={material.warnings} />
      {material.requests.some((r) => r.warnings.length) && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          ⚠ 要望ごとの警告が {material.requests.reduce((n, r) => n + r.warnings.length, 0)} 件あります（未完了は収録せず、変更の記録の無いタスクは要約に入りません）
        </p>
      )}
      {!material.requests.length ? (
        <Empty>このマイルストーンの要望はありません</Empty>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {material.requests.map((r) => {
            const recs = records.get(r.id) ?? [];
            const expanded = open === r.id;
            return (
              <li key={r.id} className="space-y-2 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <RequestStatusBadge status={r.status} />
                  <Badge tone={r.included ? "emerald" : "slate"} title={r.reason}>
                    {r.included ? "収録" : `対象外${r.reason ? `: ${r.reason}` : ""}`}
                  </Badge>
                  <Link to="/requests/$requestId" params={{ requestId: r.id }} className="min-w-0 font-medium break-words text-indigo-700 hover:underline dark:text-indigo-300">
                    {r.title}
                  </Link>
                  <span className="font-mono text-sm text-slate-500">{r.id}</span>
                  <span className={cx("text-sm", r.tasks.some((t) => !t.hasRecord) ? "text-amber-700 dark:text-amber-300" : "text-slate-500")}>
                    記録 {r.tasks.filter((t) => t.hasRecord).length}/{r.tasks.length}
                  </span>
                  {r.included && recs.length > 0 && (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : r.id)}
                      className="ml-auto text-sm text-indigo-700 underline focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none dark:text-indigo-300"
                    >
                      {expanded ? "変更の記録を閉じる" : "変更の記録を見る"}
                    </button>
                  )}
                </div>
                {r.warnings.length > 0 && (
                  <ul className="space-y-0.5 text-sm text-amber-700 dark:text-amber-300">
                    {r.warnings.map((w) => (
                      <li key={`${w.code}:${w.target}`}>⚠ {w.message}</li>
                    ))}
                  </ul>
                )}
                {expanded && (
                  <div className="space-y-3 rounded-md bg-slate-50 p-3 dark:bg-slate-900">
                    {recs.map((t) => (
                      <div key={t.id} className="space-y-1">
                        <Link
                          to="/requests/$requestId"
                          params={{ requestId: r.id }}
                          search={{ task: t.id }}
                          className="text-sm font-medium text-indigo-700 hover:underline dark:text-indigo-300"
                        >
                          {t.id} {t.title}
                        </Link>
                        <pre className="text-sm break-words whitespace-pre-wrap text-slate-700 dark:text-slate-300">{t.record}</pre>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** 警告の並び（同じ文言はまとめない。対象が違うので全部出す） */
export function Warnings({ items, tone = "amber" }: { items: ReleaseWarning[]; tone?: "amber" | "rose" }) {
  if (!items.length) return null;
  return (
    <ul
      role="status"
      className={cx(
        "space-y-1 rounded-md px-3 py-2 text-sm",
        tone === "amber" ? "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300" : "bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
      )}
    >
      {items.map((w, i) => (
        <li key={`${w.code}:${w.target}:${i}`}>⚠ {w.message}</li>
      ))}
    </ul>
  );
}
