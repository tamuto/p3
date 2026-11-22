import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReleaseMaterial, ReleaseWarning } from "../../../shared/types.ts";
import { RequestStatusBadge } from "../../../web/components/RequestStatus.tsx";
import { Badge, Button, cx, Empty } from "@infodb/p3-shared/web/ui.tsx";

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
        このマイルストーンの要望 <span className="text-base font-normal text-fg-4">収録 {included} 件 / 全 {material.requests.length} 件</span>
      </h3>
      <Warnings items={material.warnings} />
      {material.requests.some((r) => r.warnings.length) && (
        <p className="text-base text-warn">
          ⚠ 要望ごとの警告が {material.requests.reduce((n, r) => n + r.warnings.length, 0)} 件あります（未完了は収録せず、変更の記録の無いタスクは要約に入りません）
        </p>
      )}
      {!material.requests.length ? (
        <Empty>このマイルストーンの要望はありません</Empty>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
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
                  <Link to="/requests/$requestId" params={{ requestId: r.id }} className="min-w-0 font-medium break-words text-accent hover:underline">
                    {r.title}
                  </Link>
                  <span className="font-mono text-sm text-fg-4">{r.id}</span>
                  {r.structural ? (
                    // 自分のタスクが無く子だけを持つ親: 収録の判定には入るが、変更の記録は子の要望から入る
                    <Badge title="自分のタスクが無く子だけを持つ要望。収録の判定には入りますが、変更の記録は各子の要望から入ります">構造の要望（子 {r.children?.length ?? 0} 件）</Badge>
                  ) : (
                    <span className={cx("text-base", r.tasks.some((t) => !t.hasRecord) ? "text-warn" : "text-fg-4")}>
                      記録 {r.tasks.filter((t) => t.hasRecord).length}/{r.tasks.length}
                      {r.children?.length ? `・子 ${r.children.length} 件` : ""}
                    </span>
                  )}
                  {r.included && recs.length > 0 && (
                    <Button variant="link" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)} className="ml-auto">
                      {expanded ? "変更の記録を閉じる" : "変更の記録を見る"}
                    </Button>
                  )}
                </div>
                {r.warnings.length > 0 && (
                  <ul className="space-y-0.5 text-base text-warn">
                    {r.warnings.map((w) => (
                      <li key={`${w.code}:${w.target}`}>⚠ {w.message}</li>
                    ))}
                  </ul>
                )}
                {expanded && (
                  <div className="space-y-3 rounded-md bg-page p-3">
                    {recs.map((t) => (
                      <div key={t.id} className="space-y-1">
                        <Link
                          to="/requests/$requestId"
                          params={{ requestId: r.id }}
                          search={{ task: t.id }}
                          className="text-base font-medium text-accent hover:underline"
                        >
                          {t.id} {t.title}
                        </Link>
                        <pre className="text-base break-words whitespace-pre-wrap text-fg-2">{t.record}</pre>
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
        "space-y-1 rounded-md px-3 py-2 text-base",
        tone === "amber" ? "bg-warn-soft text-warn-strong" : "bg-danger-soft text-danger-strong",
      )}
    >
      {items.map((w, i) => (
        <li key={`${w.code}:${w.target}:${i}`}>⚠ {w.message}</li>
      ))}
    </ul>
  );
}
