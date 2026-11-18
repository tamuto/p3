import { metricScopeOf, metricsReport } from "../core/metrics/index.ts";
import { MetricsError, METRIC_STATE_LABEL, METRIC_UNIT_LABEL, type MetricResult, type MetricsReport } from "../shared/metrics.ts";
import { UsageError } from "./project.ts";
import type { CommandEnv } from "./args.ts";

/**
 * 開発の指標（定義は core/metrics/definitions.ts）。読むだけ。
 *
 *   metrics [--milestone <ID>]   プロジェクト全体（既定）か、登録済みのマイルストーンの指標（値・単位・対象・欠損・算出の方法）
 */

const valueText = (m: MetricResult) => {
  if (m.value === null) return METRIC_STATE_LABEL[m.state];
  const v = `${m.value} ${METRIC_UNIT_LABEL[m.unit]}`;
  return m.denominator !== undefined ? `${v} / 基準 ${m.denominator} 件` : v;
};

export function formatMetrics(r: MetricsReport): string {
  const lines = [`開発の指標  範囲: ${r.scopeLabel}`, `  ${r.scopeRule}`, "  （改善の材料です。人や AI の成績の評価には使いません）", ""];
  for (const m of r.metrics) {
    lines.push(`${m.label}  [${m.id}]  ${valueText(m)}`);
    lines.push(`    対象 ${m.targets}・値に入れた ${m.observed}・欠損 ${m.missing}`);
    lines.push(`    内訳: ${m.breakdown.map((b) => `${b.label} ${b.count}`).join("・")}`);
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
  const { ctx, out, args, o } = env;
  if (args.length) throw new UsageError(`metrics は位置引数を取りません: ${args.join(" ")}（p3 metrics [--milestone <ID>] [--json]）`);
  let scope;
  try {
    scope = metricScopeOf(ctx, o.milestone);
  } catch (e) {
    if (e instanceof MetricsError) throw new UsageError(e.message);
    throw e;
  }
  const r = await metricsReport(ctx, scope);
  return out.result(r, () => formatMetrics(r));
}
