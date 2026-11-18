import { acceptanceStatus, evidenceBasisOf, EVIDENCE_BASIS_LABEL, EVIDENCE_BASIS_KINDS, type CriterionState } from "../../shared/acceptance.ts";
import type { CompletionTrigger } from "../../shared/completionRecord.ts";
import { median, type MetricBreakdown, type MetricDefinitionInfo, type MetricMissing, type MetricResult, type MetricState } from "../../shared/metrics.ts";
import type { Request, Task } from "../../shared/types.ts";

/**
 * 開発の指標の定義（何から・どう数えるか）。指標を足すときは METRIC_DEFINITIONS に1件足す（CLI の p3 metrics・API の /api/metrics・
 * 画面は、ここに並んだ順にそのまま出す）。各定義は集計範囲の材料（MetricsInput）を受け取り、値・対象数・欠損を返す。
 *
 *   - 材料は集計範囲に入った要望（見送り・アーカイブを除く）と、その要望の直下のタスク。親子の要望はそれぞれ1件の要望で、
 *     タスクは今の直接の所属（要望のマイルストーン）で一度だけ数える
 *   - 記録の無い値は欠損（missing）で、0 や推測（updatedAt で完了時刻を推し量るなど）で埋めない
 *   - 読むだけで、ファイルを書かない。AI を動かさない
 */

/** 範囲に入った要望1件の材料 */
export interface MetricsRequestInput {
  request: Request;
  /** 直下のタスク（読めたもの） */
  tasks: Task[];
  /** 読めないタスクのファイル（ID） */
  brokenTasks: string[];
}

export interface MetricsInput {
  requests: MetricsRequestInput[];
}

export interface MetricDefinition extends MetricDefinitionInfo {
  compute: (input: MetricsInput) => Omit<MetricResult, keyof MetricDefinitionInfo>;
}

// --- 要望の所要時間 ---------------------------------------------------------------

const HOUR = 3_600_000;
const time = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  const t = Date.parse(v);
  // 読めない日時と、作成日時が無いときに読み込みが入れる 1970-01-01 は記録なし
  return Number.isNaN(t) || t <= 0 ? undefined : t;
};
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

type Reach = { kind: "reached"; hours: number } | { kind: "not_reached" } | { kind: "missing"; reason: string; unknown?: boolean };

/**
 * 要望が対応済・完了済に最初に到達するまでの時間。完了の記録（completionRecords）の最初の該当する記録の日時から作成日時を引く。
 *   - 記録が読めない・日時が読めない・作成日時より前（逆転） → 欠損
 *   - 今の状態から到達済みと分かる（対応済なのに対応済の記録が無い・完了済なのに完了済の記録が無い） → 欠損（記録を始める前のデータ）
 *   - 対応済: 完了済の記録はあるが対応済の記録が無い → 対応済を経ずに完了済にした（未到達。0 時間ではない）
 *   - 対応済: 完了済で記録が1つも無い → 到達したか分からない（欠損）
 */
function reachOf(r: Request, trigger: Extract<CompletionTrigger, "request_resolved" | "request_done">): Reach {
  if (r.completionProblems?.length) return { kind: "missing", reason: `完了の記録が読めません（${r.completionProblems.join(" / ")}）` };
  const records = r.completionRecords ?? [];
  const first = records.find((c) => c.trigger === trigger);
  if (first) {
    const at = time(first.at);
    const created = time(r.createdAt);
    if (at === undefined) return { kind: "missing", reason: `${first.id} の日時が読めません` };
    if (created === undefined) return { kind: "missing", reason: "要望の作成日時が無い・読めません" };
    if (at < created) return { kind: "missing", reason: `${first.id} の日時が作成日時より前です（日時の逆転）` };
    return { kind: "reached", hours: (at - created) / HOUR };
  }
  if (trigger === "request_resolved") {
    if (r.status === "resolved") return { kind: "missing", reason: "対応済ですが対応済の記録がありません（記録を始める前のデータ）" };
    if (r.status === "done") {
      if (records.some((c) => c.trigger === "request_done")) return { kind: "not_reached" };
      return { kind: "missing", reason: "完了済ですが記録が無く、対応済を経たか分かりません", unknown: true };
    }
    return { kind: "not_reached" };
  }
  if (r.status === "done") return { kind: "missing", reason: "完了済ですが完了済の記録がありません（記録を始める前のデータ）" };
  return { kind: "not_reached" };
}

function durationMetric(trigger: "request_resolved" | "request_done") {
  return (input: MetricsInput) => {
    const hours: number[] = [];
    const missingItems: MetricMissing[] = [];
    let notReached = 0;
    let unknown = 0;
    for (const { request: r } of input.requests) {
      const reach = reachOf(r, trigger);
      if (reach.kind === "reached") hours.push(reach.hours);
      else if (reach.kind === "not_reached") notReached += 1;
      else {
        missingItems.push({ target: r.id, reason: reach.reason });
        if (reach.unknown) unknown += 1;
      }
    }
    const m = median(hours);
    const targets = input.requests.length;
    const state: MetricState = m !== undefined ? "ok" : !targets ? "no_targets" : missingItems.length ? "no_data" : "not_reached";
    const breakdown: MetricBreakdown[] = [
      { key: "reached", label: "到達した", count: hours.length },
      { key: "not_reached", label: trigger === "request_resolved" ? "未到達（対応済を経ずに完了済を含む）" : "未到達", count: notReached },
      { key: "missing", label: "記録の欠損", count: missingItems.length - unknown },
      ...(trigger === "request_resolved" ? [{ key: "unknown", label: "履歴が無く到達したか分からない", count: unknown }] : []),
    ];
    return { state, value: m === undefined ? null : round(m), targets, observed: hours.length, missing: missingItems.length, breakdown, missingItems };
  };
}

// --- 受け入れ基準 ---------------------------------------------------------------

interface CriteriaCount {
  /** 今完了しているタスク */
  tasks: number;
  /** 基準を数えたタスク */
  counted: number;
  /** 基準なしのタスク */
  noCriteria: number;
  /** 数えた基準の合計（分母） */
  total: number;
  byState: Record<CriterionState, number>;
  metByBasis: Record<string, number>;
  missingItems: MetricMissing[];
}

/** 今完了しているタスクの、今の基準と保存された証拠の照合（shared/acceptance.ts の acceptanceStatus） */
function countCriteria(input: MetricsInput): CriteriaCount {
  const c: CriteriaCount = {
    tasks: 0,
    counted: 0,
    noCriteria: 0,
    total: 0,
    byState: { met: 0, unmet: 0, unverified: 0, missing: 0, stale: 0 },
    metByBasis: Object.fromEntries(EVIDENCE_BASIS_KINDS.map((k) => [k, 0])),
    missingItems: [],
  };
  for (const { request, tasks, brokenTasks } of input.requests) {
    // 読めないタスクは完了しているか分からないので、対象の外の欠損として知らせる
    for (const id of brokenTasks) c.missingItems.push({ target: `${request.id}/${id}`, reason: "タスクのファイルが読めません（完了しているか分かりません）" });
    for (const t of tasks) {
      if (t.status !== "done") continue;
      c.tasks += 1;
      if (t.acceptanceProblems?.length) {
        c.missingItems.push({ target: t.ref, reason: `受け入れ基準・証拠が読めません（${t.acceptanceProblems.join(" / ")}）` });
        continue;
      }
      const s = acceptanceStatus(t);
      if (!s?.total) {
        c.noCriteria += 1;
        continue;
      }
      c.counted += 1;
      c.total += s.total;
      for (const i of s.items) {
        c.byState[i.state] += 1;
        if (i.state === "met" && i.evidence) c.metByBasis[evidenceBasisOf(i.evidence).basis.kind] += 1;
      }
    }
  }
  return c;
}

const CRITERION_LABEL: Record<CriterionState, string> = {
  met: "満たした（申告）",
  unmet: "満たせなかった（未達）",
  unverified: "未検証",
  missing: "証拠なし",
  stale: "基準を変えた後の再確認が必要",
};

function criteriaMetric(state: CriterionState) {
  return (input: MetricsInput) => {
    const c = countCriteria(input);
    const brokenTasks = c.missingItems.length;
    const value = c.byState[state];
    // 数えた基準が無いとき、欠損があれば「欠損で出せない」、無ければ「対象なし」（0 件とは言わない）
    const st: MetricState = c.total ? "ok" : brokenTasks ? "no_data" : "no_targets";
    const breakdown: MetricBreakdown[] = [
      ...(state === "met"
        ? EVIDENCE_BASIS_KINDS.filter((k) => k !== "unverified").map((k) => ({ key: `basis_${k}`, label: `根拠: ${EVIDENCE_BASIS_LABEL[k]}`, count: c.metByBasis[k] }))
        : (Object.keys(CRITERION_LABEL) as CriterionState[]).map((k) => ({ key: k, label: CRITERION_LABEL[k], count: c.byState[k] }))),
      { key: "tasks_counted", label: "基準を数えた完了タスク", count: c.counted },
      { key: "tasks_no_criteria", label: "基準なしの完了タスク（対象なし）", count: c.noCriteria },
      { key: "tasks_missing", label: "基準が読めない・読めないタスク（欠損）", count: brokenTasks },
    ];
    return { state: st, value: st === "ok" ? value : null, targets: c.tasks, observed: c.counted, missing: brokenTasks, denominator: c.total, breakdown, missingItems: c.missingItems };
  };
}

const CRITERIA_SOURCE = "完了しているタスクの受け入れ基準（acceptanceCriteria）と証拠（acceptanceEvidence）";
const CRITERIA_TARGET = "範囲の要望の直下で今完了しているタスク。基準なしのタスクは対象なし";
const CRITERIA_MISSING = "基準・証拠が読めないタスクと読めないタスクのファイルは欠損（分母に入れない）。対応する基準の無い証拠は分母の外";

/** 指標の定義（この順に出す） */
export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    id: "request_to_resolved",
    label: "要望の作成から対応済まで",
    unit: "hours",
    source: "要望の作成日時（createdAt）と完了の記録（completionRecords）の最初の対応済（request_resolved）",
    target: "範囲の要望（見送り・アーカイブを除く。親子の要望もそれぞれ1件）",
    method: "到達した要望の経過時間の中央値（時間）。到達していない要望は数えない",
    missingRule: "記録・日時が読めない、日時の逆転、対応済なのに記録が無い要望は欠損。完了済への直接の遷移は未到達で、0 時間にしない",
    compute: durationMetric("request_resolved"),
  },
  {
    id: "request_to_done",
    label: "要望の作成から完了済まで",
    unit: "hours",
    source: "要望の作成日時（createdAt）と完了の記録（completionRecords）の最初の完了済（request_done）",
    target: "範囲の要望（見送り・アーカイブを除く。親子の要望もそれぞれ1件）",
    method: "到達した要望の経過時間の中央値（時間）。到達していない要望は数えない",
    missingRule: "記録・日時が読めない、日時の逆転、完了済なのに記録が無い要望は欠損（updatedAt で推し量らない）",
    compute: durationMetric("request_done"),
  },
  {
    id: "acceptance_unmet",
    label: "未達の受け入れ基準",
    unit: "count",
    source: CRITERIA_SOURCE,
    target: CRITERIA_TARGET,
    method: "今の基準のうち、今の文言で「満たせなかった」と記録した基準の数。分母は数えた基準の合計",
    missingRule: CRITERIA_MISSING,
    compute: criteriaMetric("unmet"),
  },
  {
    id: "acceptance_unverified",
    label: "未検証の受け入れ基準",
    unit: "count",
    source: CRITERIA_SOURCE,
    target: CRITERIA_TARGET,
    method: "今の基準のうち、今の文言で「未検証」と記録した基準の数。分母は数えた基準の合計",
    missingRule: CRITERIA_MISSING,
    compute: criteriaMetric("unverified"),
  },
  {
    id: "acceptance_no_evidence",
    label: "証拠なしの受け入れ基準",
    unit: "count",
    source: CRITERIA_SOURCE,
    target: CRITERIA_TARGET,
    method: "今の基準のうち、証拠の無い基準の数。分母は数えた基準の合計",
    missingRule: CRITERIA_MISSING,
    compute: criteriaMetric("missing"),
  },
  {
    id: "acceptance_stale",
    label: "再確認が必要な受け入れ基準",
    unit: "count",
    source: CRITERIA_SOURCE,
    target: CRITERIA_TARGET,
    method: "証拠を記録した後に基準の文言を変えた基準の数。分母は数えた基準の合計",
    missingRule: CRITERIA_MISSING,
    compute: criteriaMetric("stale"),
  },
  {
    id: "acceptance_met",
    label: "満たしたと申告した受け入れ基準",
    unit: "count",
    source: CRITERIA_SOURCE,
    target: CRITERIA_TARGET,
    method: "今の基準のうち、今の文言で「満たした」と記録した基準の数（作業した側の申告で、確かめた数ではない）。内訳に根拠の種類（申告のみを含む）。分母は数えた基準の合計",
    missingRule: CRITERIA_MISSING,
    compute: criteriaMetric("met"),
  },
];
