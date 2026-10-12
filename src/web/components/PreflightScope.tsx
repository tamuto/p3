import type { RefScope, RepoRef } from "../../shared/repos.ts";
import { evidenceWhere, historyLabel, SCOPE_STATUS_LABEL } from "../../shared/scopeView.ts";
import type { Evidence } from "../../shared/types.ts";
import { Badge, cx, Section } from "./ui.tsx";

/**
 * Preflight の「調べた範囲」（参照先ごとに読んだか。P3 が始めるときに決めた記録）と、
 * 参照先の主なフォルダ（今の設定）、「判断の根拠」（確かめた / 推測。P3 が確かめ直したもの）。
 */
export function PreflightScope({ scope, repos, evidence }: { scope?: RefScope[]; repos: RepoRef[]; evidence?: Evidence[] | null }) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Section title="調べた範囲（参照先）">
        {!scope ? (
          <p className="text-sm text-slate-500">記録なし（以前の評価）</p>
        ) : !scope.length ? (
          <p className="text-sm text-slate-500">参照先なし</p>
        ) : (
          <ul className="space-y-2">
            {scope.map((s) => {
              const def = repos.find((r) => r.name === s.name);
              return (
                <li key={s.name} className="space-y-1 rounded-lg bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium break-all">{s.name}</span>
                    {s.role && <span className="text-sm text-slate-500">{s.role}</span>}
                    {s.readFirst && <Badge tone="indigo">最初に読む</Badge>}
                    <Badge tone={s.status === "ok" ? "emerald" : "rose"}>{SCOPE_STATUS_LABEL[s.status]}</Badge>
                    {s.history && (
                      <Badge tone={s.history.status === "ok" ? "slate" : "amber"} title={s.history.reason}>
                        {s.history.status === "ok" ? "git の履歴あり" : s.history.status === "shallow" ? "git の履歴は途中まで" : "git の履歴なし"}
                      </Badge>
                    )}
                  </div>
                  {s.history && s.history.status !== "ok" && <p className="text-sm break-words text-amber-700 dark:text-amber-400">{historyLabel(s.history)}</p>}
                  {s.status !== "ok" && (
                    <p className="text-sm break-words text-rose-700 dark:text-rose-300">
                      {s.reason ?? SCOPE_STATUS_LABEL[s.status]}。中身は確かめていないので、関わる判断は推測です
                    </p>
                  )}
                  {def && def.map.length > 0 && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-slate-500">主なフォルダ（今の設定）</summary>
                      <ul className="mt-1 space-y-0.5 pl-4">
                        {def.map.map((m) => (
                          <li key={m.path} className="break-words">
                            <code className="font-mono break-all">{m.path}</code> — {m.role || "（役割なし）"}
                            {m.entry && (
                              <>
                                （入口 <code className="font-mono break-all">{m.entry}</code>）
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      {evidence !== null && (
        <Section title="判断の根拠">
          {evidence === undefined ? (
            <p className="text-sm text-slate-500">記録なし（以前の評価）</p>
          ) : !evidence.length ? (
            <p className="text-sm text-slate-500">なし</p>
          ) : (
            <ul className="space-y-1.5">
              {evidence.map((e, i) => (
                <li key={i} className="flex items-start gap-2">
                  <Badge tone={e.kind === "verified" ? "emerald" : "amber"} className="mt-0.5">
                    {e.kind === "verified" ? "確かめた" : "推測"}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="break-words">{e.claim}</p>
                    {evidenceWhere(e) && <p className={cx("font-mono text-sm break-all", e.kind === "verified" ? "text-slate-500" : "text-slate-400")}>{evidenceWhere(e)}</p>}
                    {e.note && <p className="text-sm text-amber-700 dark:text-amber-300">※ {e.note}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
