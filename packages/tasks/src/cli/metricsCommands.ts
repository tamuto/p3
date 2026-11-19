import { metricScopeOf, metricsReport } from "../core/metrics/index.ts";
import { readManual, recordManual, removeManual } from "../core/metrics/manual.ts";
import { MetricsError, METRIC_STATE_LABEL, METRIC_UNIT_LABEL, type ManualRecord, type ManualRow, type MetricResult, type MetricsReport } from "../shared/metrics.ts";
import { UsageError } from "@infodb/p3-kit/usage.ts";
import type { CommandEnv } from "./args.ts";

/**
 * 開発の指標（定義は core/metrics/definitions.ts）。読むだけ。
 *
 *   metrics [--milestone <ID>]   プロジェクト全体（既定）か、登録済みのマイルストーンの指標（値・単位・対象・欠損・算出の方法）
 *   metrics record <指標> <値> --from YYYY-MM-DD --to YYYY-MM-DD --source 出典 [--unit 通貨] [--milestone ID] [--note メモ] [--rev 版]
 *                                人が記録する値（費用・リリース後の不具合）。同じ内容の再送は何もしない。訂正は --rev
 *   metrics records               人の記録の全部（範囲を問わない）
 *   metrics rm <M1> [--rev 版]    人の記録を消す
 */

const rowText = (r: ManualRow) => `${r.id}  ${r.from}〜${r.to}  ${r.value} ${r.unit}  出典: ${r.source}${r.note ? `  メモ: ${r.note}` : ""}  （版 ${r.rev}・${r.updatedAt}${r.updatedBy ? `・${r.updatedBy}` : ""}）`;
const recordText = (r: ManualRecord) => `${r.metric}  ${r.scope === "project" ? "プロジェクト全体" : r.scope}  ${rowText(r)}`;

const valueText = (m: MetricResult) => {
  if (m.rows?.length) return m.rows.length === 1 ? `${m.rows[0].value} ${m.rows[0].unit}` : `${m.rows.length} 行（期間・単位ごと。合算しない）`;
  if (m.value === null) return METRIC_STATE_LABEL[m.state];
  const v = `${m.value} ${METRIC_UNIT_LABEL[m.unit]}`;
  return m.denominator !== undefined ? `${v} / 基準 ${m.denominator} 件` : v;
};

export function formatMetrics(r: MetricsReport): string {
  const lines = [`開発の指標  範囲: ${r.scopeLabel}`, `  ${r.scopeRule}`, "  （改善の材料です。人や AI の成績の評価には使いません）", ""];
  for (const m of r.metrics) {
    lines.push(`${m.label}  [${m.id}]  ${valueText(m)}${m.kind === "manual" ? "  （人の記録）" : ""}`);
    if (m.kind === "manual") {
      for (const r of m.rows ?? []) lines.push(`    ${rowText(r)}`);
      if (m.recordHint) lines.push(`    記録: ${m.recordHint}`);
    } else {
      lines.push(`    対象 ${m.targets}・値に入れた ${m.observed}・欠損 ${m.missing}`);
      lines.push(`    内訳: ${m.breakdown.map((b) => `${b.label} ${b.count}`).join("・")}`);
    }
    lines.push(`    算出: ${m.method}`);
    for (const x of m.missingItems.slice(0, 5)) lines.push(`    欠損: ${x.target}  ${x.reason}`);
    if (m.missingItems.length > 5) lines.push(`    欠損: ほか ${m.missingItems.length - 5} 件（--json で全部）`);
  }
  if (r.notices.length) lines.push("", "知らせ:", ...r.notices.map((n) => `  ${n.target}  ${n.message}`));
  lines.push("", `範囲: ${r.scopes.map((s) => (s.scope.kind === "project" ? "（省略）プロジェクト全体" : `--milestone ${s.scope.id}`)).join(" / ")}`);
  return lines.join("\n");
}

export async function metricsCommand(cmd: string, env: CommandEnv): Promise<number | undefined> {
  if (cmd !== "metrics") return undefined;
  const { ctx, out, args, o, actor, expectedRev } = env;
  const sub = args[0];
  if (sub === "record") {
    const [, metric, value] = args;
    if (!metric || value === undefined || args.length > 3) throw new UsageError("p3 metrics record <指標> <値> --from YYYY-MM-DD --to YYYY-MM-DD --source 出典 [--unit 通貨] [--milestone ID] [--note メモ] [--rev 版]");
    const r = await recordManual(ctx, { metric, value, scope: o.milestone, from: o.from ?? "", to: o.to ?? "", unit: o.unit, source: o.source ?? "", note: o.note }, { expectedRev, actor });
    return out.result(r, () => `${r.created ? "記録しました" : r.changed ? "訂正しました" : "同じ内容の記録があります（変えていません）"}\n  ${recordText(r.record)}`);
  }
  if (sub === "records") {
    const m = await readManual(ctx.ws.dataDir);
    if (m.problem) throw new MetricsError(m.problem, "metrics_unreadable");
    return out.result({ records: m.records }, () => (m.records.length ? m.records.map(recordText).join("\n") : "人の記録はありません（p3 metrics record で記録します）"));
  }
  if (sub === "rm" || sub === "remove") {
    if (!args[1] || args.length > 2) throw new UsageError("p3 metrics rm <M1> [--rev 版]");
    const r = await removeManual(ctx, args[1], { expectedRev });
    return out.result({ removed: r }, () => `消しました: ${recordText(r)}`);
  }
  if (args.length) throw new UsageError(`p3 metrics [--milestone <ID>] | record <指標> <値> ... | records | rm <M1>（知らない引数: ${args.join(" ")}）`);
  const r = await metricsReport(ctx, metricScopeOf(ctx, o.milestone));
  return out.result(r, () => formatMetrics(r));
}
