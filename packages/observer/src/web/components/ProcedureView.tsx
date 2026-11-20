import type { ReactNode } from "react";
import { FILE_STATE_LABEL, fileKey, MEASURE_TYPE_LABEL, RUN_KIND_LABEL, type FileState, type Measure, type Procedure } from "../../shared/definition.ts";

/**
 * 確認の手順1つの表示（観測の詳細と AI の提案で共通）。今の実行方法・測る項目・置き換え候補・切り替えの履歴を見出しとラベルで分け、
 * ファイルには参照先の中での有無（既にある・新規予定・未確認）と確認した時刻を添える
 */
export function ProcedureView({ p, label, measures, files, children }: { p: Procedure; label: string; measures: Measure[]; files: Record<string, { state: FileState; checkedAt: string }>; children?: ReactNode }) {
  const r = p.run;
  const file = (repo: string, path: string) => {
    const f = files[fileKey(repo, path)];
    return (
      <>
        <code className="break-all">
          {repo}:{path}
        </code>
        <span className="ml-2 text-slate-600 dark:text-slate-400">［{f ? `${FILE_STATE_LABEL[f.state]}・${new Date(f.checkedAt).toLocaleString()} に確認` : "確認中"}］</span>
      </>
    );
  };
  const row = (term: string, value: ReactNode) => (
    <>
      <dt className="font-medium text-slate-600 dark:text-slate-400">{term}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  );
  const measureOf = (n: string) => measures.find((m) => m.name === n);
  return (
    <article aria-label={label} className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <h3 className="text-lg font-semibold">
        {label}
        <span className="ml-2 font-normal text-slate-600 dark:text-slate-400">（今の実行方法: {RUN_KIND_LABEL[r.kind]}）</span>
      </h3>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
        {r.kind === "ai-instruction" && (
          <>
            {r.premise && row("前提", r.premise)}
            {row("対象", r.target)}
            {row(
              "順に行う操作",
              <ol className="list-decimal pl-6">
                {r.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>,
            )}
            {row("判定", r.judge)}
            {row("測定値の記録", r.record)}
          </>
        )}
        {r.kind === "command" && (
          <>
            {row("コマンド", <code className="break-all">{[r.command, ...r.args].join(" ")}</code>)}
            {row("作業場所", r.repo ? `${r.repo}:${r.cwd ?? "."}` : "決めない")}
          </>
        )}
        {r.kind !== "ai-instruction" && r.kind !== "command" && (
          <>
            {row("ファイル", file(r.repo, r.path))}
            {row("呼び出し方", r.invoke ? <code className="break-all">{r.invoke}</code> : "決めない")}
          </>
        )}
        {row(
          "測る項目",
          p.measures.length
            ? p.measures
                .map((n) => {
                  const m = measureOf(n);
                  return `${n}（${m ? MEASURE_TYPE_LABEL[m.type] : "?"}${m?.unit ? `・${m.unit}` : ""}）`;
                })
                .join("、")
            : "なし",
        )}
      </dl>
      {p.replacement && (
        <section aria-label={`${label} の置き換え候補`} className="space-y-1 rounded-md bg-indigo-50 p-3 dark:bg-indigo-950/40">
          <h4 className="font-semibold">置き換え候補（{RUN_KIND_LABEL[p.replacement.kind]}）</h4>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
            {row("用意するファイル", file(p.replacement.repo, p.replacement.path))}
            {row("再現する操作", p.replacement.operation)}
            {row("測定値の出力形式", p.replacement.output)}
            {row("結果を比べる条件", p.replacement.compare)}
            {row("切り替えの条件", p.replacement.switchWhen)}
            {p.replacement.invoke && row("呼び出し方の案", <code className="break-all">{p.replacement.invoke}</code>)}
          </dl>
        </section>
      )}
      {!!p.history?.length && (
        <section aria-label={`${label} の切り替えの履歴`} className="space-y-1">
          <h4 className="font-semibold">切り替えの履歴</h4>
          <ul className="space-y-1">
            {p.history.map((h, i) => (
              <li key={i}>
                {new Date(h.at).toLocaleString()} {h.by}: {RUN_KIND_LABEL[h.from.kind]}
                {h.from.kind === "ai-instruction" ? `（対象: ${h.from.target}）` : ""} から切り替え。呼び出し方 <code className="break-all">{h.invoke}</code>・根拠: {h.evidence}
              </li>
            ))}
          </ul>
        </section>
      )}
      {children}
    </article>
  );
}
