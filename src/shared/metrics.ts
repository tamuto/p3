/**
 * 開発の指標（記録から出す値と、人が記録する値）の型。CLI・API・画面で同じものを使う。
 * 定義（何から・どう数えるか）と集計は core/metrics/definitions.ts の1か所にある（指標を足すときはそこに1件足す）。
 *
 *   - 指標は改善の材料で、人や AI の成績の評価には使わない（個人・エージェントごとの値や順位は出さない）
 *   - 値の無い理由を数値の 0 と区別する: 対象なし（no_targets）・記録の欠損だけ（no_data）・まだ到達していない（not_reached）
 *   - 古い記録で欠けている値は欠損として数え、0 や推測（updatedAt など）で埋めない
 */

/** 集計範囲。project はプロジェクト全体（マイルストーンなしの要望を含む）、milestone は登録済みのマイルストーンに直接属する要望 */
export type MetricScope = { kind: "project" } | { kind: "milestone"; id: string };

export const METRIC_UNITS = ["hours", "count", "amount"] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];
/** amount は通貨ごとの金額（単位は記録ごとの通貨コード） */
export const METRIC_UNIT_LABEL: Record<MetricUnit, string> = { hours: "時間", count: "件", amount: "金額" };

/** record: p3 の記録から数える / manual: 人が記録した値（p3 metrics record） */
export type MetricKind = "record" | "manual";

/**
 * 値の状態。ok: 値あり / no_targets: 数える対象が無い / no_data: 対象はあるが記録が欠けて値を出せない /
 * not_reached: 対象はあるがまだどれも到達していない（所要時間の指標） / unrecorded: 対象はあるが記録がまだ無い（レビューをしていない・値を記録していない）
 */
export const METRIC_STATES = ["ok", "no_targets", "no_data", "not_reached", "unrecorded"] as const;
export type MetricState = (typeof METRIC_STATES)[number];
export const METRIC_STATE_LABEL: Record<MetricState, string> = {
  ok: "値あり",
  no_targets: "対象なし",
  no_data: "記録の欠損で出せない",
  not_reached: "まだ到達していない",
  unrecorded: "記録なし",
};

/** 指標の定義（説明。計算の関数は core にある） */
export interface MetricDefinitionInfo {
  /** 安定した ID（例: request_to_resolved） */
  id: string;
  label: string;
  unit: MetricUnit;
  /** 何から数えるか（記録の項目） */
  source: string;
  /** 対象の条件 */
  target: string;
  /** 算出の方法 */
  method: string;
  /** 欠損の扱い */
  missingRule: string;
  kind: MetricKind;
  /** 人が記録する指標の記録のしかた（CLI の例） */
  recordHint?: string;
}

/** 内訳の1行 */
export interface MetricBreakdown {
  key: string;
  label: string;
  count: number;
}

/** 欠損の1件（対象と理由） */
export interface MetricMissing {
  target: string;
  reason: string;
}

/** 指標1件の結果 */
export interface MetricResult extends MetricDefinitionInfo {
  state: MetricState;
  /** 値（state が ok のときだけ。ほかは null） */
  value: number | null;
  /** 対象の数（要望・タスクなど。定義の target を満たすもの） */
  targets: number;
  /** 値に入った対象の数 */
  observed: number;
  /** 記録が欠けて数えられなかった対象の数 */
  missing: number;
  /** 割合の分母（件数の指標で、数えた基準の合計など。無い指標は持たない） */
  denominator?: number;
  breakdown: MetricBreakdown[];
  missingItems: MetricMissing[];
  /** 人が記録した値（範囲と一致する記録。期間・単位ごとに1行で、合算しない） */
  rows?: ManualRow[];
}

/** 人が記録した値1件（範囲は project かマイルストーン ID。指標・範囲・期間・単位で1件） */
export interface ManualRecord {
  /** M1, M2, ...（消しても使い直さない） */
  id: string;
  metric: string;
  /** "project" かマイルストーン ID */
  scope: string;
  /** 観測の開始日・終了日（YYYY-MM-DD。両端を含む） */
  from: string;
  to: string;
  value: number;
  /** 通貨コード（JPY・USD など）か「件」 */
  unit: string;
  /** 出典（請求書・課金の画面・不具合の管理表など） */
  source: string;
  note?: string;
  rev: number;
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy?: string;
}

export type ManualRow = Omit<ManualRecord, "metric" | "scope">;

/** 集計の全体への知らせ（所属を判定できない記録など） */
export interface MetricNotice {
  /** broken_request: 読めない要望 / manual_unreadable: 人の記録のファイルが読めない / manual_orphan: 登録に無いマイルストーンへの人の記録 */
  code: "broken_request" | "manual_unreadable" | "manual_orphan";
  target: string;
  message: string;
}

/** 選べる集計範囲 */
export interface MetricScopeOption {
  scope: MetricScope;
  label: string;
}

export interface MetricsReport {
  scope: MetricScope;
  /** 範囲の表示名 */
  scopeLabel: string;
  /** 範囲に入れた条件の説明 */
  scopeRule: string;
  generatedAt: string;
  metrics: MetricResult[];
  notices: MetricNotice[];
  /** 選べる範囲（プロジェクト全体と登録済みのマイルストーン） */
  scopes: MetricScopeOption[];
}

/**
 * metrics_invalid: 入力が規則に合わない（知らない指標・範囲・負の値・不正な期間など。CLI は 1、API は 400）/
 * metrics_conflict: 読んだ版と違う・版を照らさない訂正（CLI は 3）/ metrics_unreadable: 記録のファイルが読めない（CLI は 1）。どれも何も書いていない
 */
export class MetricsError extends Error {
  constructor(
    message: string,
    readonly code: "metrics_invalid" | "metrics_conflict" | "metrics_unreadable" = "metrics_invalid",
  ) {
    super(message);
  }
}

/** 中央値（空なら undefined） */
export function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
