/**
 * 観測の項目キーと値（docs/architecture.md「p3-observer」）。観測は「項目キーに値を登録する」ことだけを受け持ち、その値を何を実行して得たかには
 * 関与しない（コマンド・手順・環境を受け取る項目は作らない）。判定もしない（目安は値と並べて見せるだけ）。
 * 項目と検証はここの1か所（CLI・API・画面が同じ検証を使い、誤りは項目の場所 path ごとに返す）。
 */

export const METRIC_TYPES = ["number", "string", "boolean", "json"] as const;
export type MetricType = (typeof METRIC_TYPES)[number];
export const METRIC_TYPE_LABEL: Record<MetricType, string> = { number: "数値", string: "文字列", boolean: "論理値", json: "構造化データ" };
export const isMetricType = (v: unknown): v is MetricType => (METRIC_TYPES as readonly unknown[]).includes(v);

/** 目安。数値は下限・上限（片方だけでもよい）、文字列・論理値は期待する値、構造化データは持たない */
export interface MetricGuide {
  min?: number;
  max?: number;
  expected?: string | boolean;
}

/** カードに出す数（数値の項目だけ選べる。無ければ最後の値） */
export const METRIC_AGGREGATES = ["sum", "avg", "last"] as const;
export type MetricAggregate = (typeof METRIC_AGGREGATES)[number];
export const METRIC_AGGREGATE_LABEL: Record<MetricAggregate, string> = { sum: "合計", avg: "平均", last: "最後の値" };

/** 項目キーの定義（利用者が登録したもの。システムの項目は SYSTEM_KEYS で、system が付く） */
export interface MetricKey {
  key: string;
  name: string;
  description?: string;
  type: MetricType;
  unit?: string;
  guide?: MetricGuide;
  aggregate?: MetricAggregate;
  system?: true;
  rev: number;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

/** 一覧の1件（値の数・カードの数はマイルストーンで絞ったときはその値で） */
export interface KeySummary extends MetricKey {
  count: number;
  latest?: MetricValue;
  /** カードに出す数（項目キーの集計の方法で。値が無ければ無い） */
  card?: MetricData;
  /** 推移（数値の項目だけ。古い順に最後の SERIES_MAX 件） */
  series?: { at: string; value: number }[];
}

export type MetricData = number | string | boolean | Record<string, unknown> | unknown[];

/** 値の1件。何を実行して得たかは持たない */
export interface MetricValue {
  /** 項目キーの中で一意（V1, V2, ...。消した番号は使い直さない） */
  id: string;
  /** いつの値か（期間で考える値は期間の終わり） */
  at: string;
  value: MetricData;
  by: string;
  recordedAt: string;
  /** 対象（要望 ID・タスク ID などの文字列） */
  target?: string;
  milestone?: string;
  note?: string;
}

export interface Problem {
  path: string;
  message: string;
}

/** システムの項目（p3 が tasks の操作のその場で記録する。利用者は作れず、値を足す・消すこともできない） */
export const SYSTEM_PREFIX = "p3.";
const criteria = (state: string, label: string): MetricKey => ({
  key: `p3.task.criteria.${state}`,
  name: `完了時の受け入れ基準: ${label}`,
  type: "number",
  unit: "件",
  description: `タスクが完了になったときの、${label}の受け入れ基準の数。基準の無いタスクは記録しない`,
  aggregate: "sum",
  system: true,
  rev: 0,
});
export const SYSTEM_KEYS: readonly MetricKey[] = [
  { key: "p3.request.lead_time_resolved", name: "要望の到達時間（対応済まで）", type: "number", unit: "時間", description: "要望が初めて対応済になったときの、作成からの時間", aggregate: "avg", system: true, rev: 0 },
  { key: "p3.request.lead_time_done", name: "要望の到達時間（完了済まで）", type: "number", unit: "時間", description: "要望が初めて完了済になったときの、作成からの時間", aggregate: "avg", system: true, rev: 0 },
  criteria("unmet", "未達"),
  criteria("unverified", "未検証"),
  criteria("missing", "証拠なし"),
  criteria("stale", "古い証拠（基準を変えた後）"),
  criteria("met", "満たした"),
  { key: "p3.task.rework", name: "手戻り", type: "number", unit: "件", description: "タスクを完了から戻したとき 1", aggregate: "sum", system: true, rev: 0 },
];
/** 完了時の受け入れ基準の状態ごとの項目（acceptanceStatus の状態と同じ名前） */
export const CRITERIA_STATES = ["unmet", "unverified", "missing", "stale", "met"] as const;
export type SystemKey = "p3.request.lead_time_resolved" | "p3.request.lead_time_done" | `p3.task.criteria.${(typeof CRITERIA_STATES)[number]}` | "p3.task.rework";
export const systemKey = (key: string) => SYSTEM_KEYS.find((k) => k.key === key);

export const METRIC_LIMITS = { key: 100, name: 200, description: 2000, unit: 50, expected: 1000, string: 10_000, json: 100_000, target: 200, milestone: 100, note: 2000 } as const;
/** 英小文字・数字・.・_・- だけ。先頭は英小文字か数字（ファイル名に使うので . で始めない） */
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);

export function keyProblem(key: unknown): string | undefined {
  if (typeof key !== "string" || !key) return "項目キーを入れてください";
  if (key.length > METRIC_LIMITS.key) return `項目キーは ${METRIC_LIMITS.key} 文字まで`;
  if (!KEY_PATTERN.test(key)) return "項目キーは英小文字・数字・.・_・- だけで、英小文字か数字で始めます";
  if (key === "new") return "new は画面の登録のページ（/observer/new）と重なるので使えません";
  return undefined;
}

/** 項目キーの入力（作成・変更）。作成は key が要り、システム用の p3. で始まるキーは作れない */
export function checkKeyInput(input: Record<string, unknown>, creating: boolean): { value?: Omit<MetricKey, "rev">; problems: Problem[] } {
  const problems: Problem[] = [];
  const push = (path: string, message: string) => problems.push({ path, message });
  const key = str(input.key) ?? "";
  if (creating) {
    const p = keyProblem(key);
    if (p) push("key", p);
    else if (key.startsWith(SYSTEM_PREFIX)) push("key", `${SYSTEM_PREFIX} で始まるキーはシステム用で、作れません`);
  }
  const name = str(input.name) ?? "";
  if (!name) push("name", "名前を入れてください");
  else if (name.length > METRIC_LIMITS.name) push("name", `名前は ${METRIC_LIMITS.name} 文字まで`);
  const description = str(input.description) || undefined;
  if (description && description.length > METRIC_LIMITS.description) push("description", `説明は ${METRIC_LIMITS.description} 文字まで`);
  const type = input.type;
  if (!isMetricType(type)) push("type", "値の形は number（数値）・string（文字列）・boolean（論理値）・json（構造化データ）のどれか");
  const unit = str(input.unit) || undefined;
  if (unit && unit.length > METRIC_LIMITS.unit) push("unit", `単位は ${METRIC_LIMITS.unit} 文字まで`);
  const guide = isMetricType(type) ? checkGuide(input.guide, type, push) : undefined;
  const aggregate = input.aggregate === undefined || input.aggregate === null || input.aggregate === "" ? undefined : input.aggregate;
  if (aggregate !== undefined && !(METRIC_AGGREGATES as readonly unknown[]).includes(aggregate)) push("aggregate", "カードに出す数は sum（合計）・avg（平均）・last（最後の値）のどれか");
  else if (aggregate !== undefined && aggregate !== "last" && type !== "number") push("aggregate", "合計・平均は数値の項目だけに選べます");
  if (problems.length || !isMetricType(type)) return { problems };
  const agg = aggregate && aggregate !== "last" ? (aggregate as MetricAggregate) : undefined;
  return { value: { key, name, ...(description ? { description } : {}), type, ...(unit ? { unit } : {}), ...(guide ? { guide } : {}), ...(agg ? { aggregate: agg } : {}) }, problems };
}

function checkGuide(raw: unknown, type: MetricType, push: (path: string, message: string) => void): MetricGuide | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return push("guide", "目安の形が違います"), undefined;
  const g = raw as Record<string, unknown>;
  const empty = (v: unknown) => v === undefined || v === null || v === "";
  if (type === "json") {
    if (Object.values(g).some((v) => !empty(v))) push("guide", "構造化データには目安を付けられません");
    return undefined;
  }
  if (type === "number") {
    if (!empty(g.expected)) push("guide.expected", "数値の目安は下限・上限で書きます");
    const num = (k: "min" | "max") => {
      if (empty(g[k])) return undefined;
      const n = typeof g[k] === "number" ? g[k] : Number(g[k]);
      if (!Number.isFinite(n)) return push(`guide.${k}`, `${k === "min" ? "下限" : "上限"}は数値で書きます`), undefined;
      return n;
    };
    const min = num("min");
    const max = num("max");
    if (min !== undefined && max !== undefined && min > max) push("guide", "下限が上限より大きくなっています");
    return min === undefined && max === undefined ? undefined : { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }
  if (!empty(g.min) || !empty(g.max)) push("guide", "下限・上限は数値の項目だけに付けられます");
  if (empty(g.expected)) return undefined;
  if (type === "boolean") {
    const b = g.expected === true || g.expected === "true" ? true : g.expected === false || g.expected === "false" ? false : undefined;
    if (b === undefined) return push("guide.expected", "期待する値は true か false"), undefined;
    return { expected: b };
  }
  const s = String(g.expected);
  if (s.length > METRIC_LIMITS.expected) return push("guide.expected", `期待する値は ${METRIC_LIMITS.expected} 文字まで`), undefined;
  return { expected: s };
}

/** 値の入力。at は省くと登録した時刻（YYYY-MM-DD も受け付ける） */
export function checkValueInput(type: MetricType, input: Record<string, unknown>, now: string): { value?: Omit<MetricValue, "id" | "by" | "recordedAt">; problems: Problem[] } {
  const problems: Problem[] = [];
  const push = (path: string, message: string) => problems.push({ path, message });
  const value = checkData(type, input.value, push);
  let at = now;
  if (input.at !== undefined && input.at !== null && input.at !== "") {
    const t = typeof input.at === "string" ? Date.parse(input.at) : Number.NaN;
    if (Number.isNaN(t)) push("at", "いつの値かは日付（YYYY-MM-DD）か日時（ISO 8601）で書きます");
    else at = new Date(t).toISOString();
  }
  const opt = (k: "target" | "milestone" | "note") => {
    const v = str(input[k]) || undefined;
    if (v && v.length > METRIC_LIMITS[k]) push(k, `${{ target: "対象", milestone: "マイルストーン", note: "メモ" }[k]}は ${METRIC_LIMITS[k]} 文字まで`);
    return v;
  };
  const target = opt("target");
  const milestone = opt("milestone");
  const note = opt("note");
  if (problems.length || value === undefined) return { problems };
  return { value: { at, value, ...(target ? { target } : {}), ...(milestone ? { milestone } : {}), ...(note ? { note } : {}) }, problems };
}

function checkData(type: MetricType, v: unknown, push: (path: string, message: string) => void): MetricData | undefined {
  const label = METRIC_TYPE_LABEL[type];
  if (type === "number" && typeof v === "number" && Number.isFinite(v)) return v;
  if (type === "boolean" && typeof v === "boolean") return v;
  if (type === "string" && typeof v === "string") {
    if (v.length > METRIC_LIMITS.string) return push("value", `文字列の値は ${METRIC_LIMITS.string} 文字まで`), undefined;
    return v;
  }
  if (type === "json" && typeof v === "object" && v !== null) {
    if (JSON.stringify(v).length > METRIC_LIMITS.json) return push("value", `構造化データの値は JSON で ${METRIC_LIMITS.json} 文字まで`), undefined;
    return v as MetricData;
  }
  push("value", type === "json" ? "値は構造化データ（JSON のオブジェクトか配列）で入れます" : `値は${label}で入れます`);
  return undefined;
}

/** CLI・画面の文字の入力を、項目の値の形に読み替える（読めなければ文字のまま返し、検証で断る） */
export function parseValueText(type: MetricType, text: string): unknown {
  const t = text.trim();
  if (type === "number") return t === "" ? t : Number(t);
  if (type === "boolean") return t === "true" ? true : t === "false" ? false : t;
  if (type === "json") {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return t;
    }
  }
  return text;
}

/** 表示の文字（構造化データは JSON） */
export function formatValue(v: MetricData): string {
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function formatGuide(k: Pick<MetricKey, "guide" | "unit">): string | undefined {
  const g = k.guide;
  if (!g) return undefined;
  const u = k.unit ? ` ${k.unit}` : "";
  if (g.expected !== undefined) return `期待する値: ${String(g.expected)}`;
  if (g.min !== undefined && g.max !== undefined) return `${g.min}〜${g.max}${u}`;
  if (g.min !== undefined) return `${g.min}${u} 以上`;
  if (g.max !== undefined) return `${g.max}${u} 以下`;
  return undefined;
}

export const SERIES_MAX = 30;

/**
 * カードの数と推移（values は新しい順。合計・平均は数値だけ。平均は小数 2 桁で丸める）。推移は古い順に最後の SERIES_MAX 点で、合計の項目は
 * 累計（値1つが1件の出来事のとき、1件ずつの線は平らで読めないため）、ほかは値そのもの。判定はしない
 */
export function cardOf(k: Pick<MetricKey, "type" | "aggregate">, values: readonly MetricValue[]): Pick<KeySummary, "card" | "series"> {
  if (!values.length) return {};
  if (k.type !== "number") return { card: values[0].value };
  const round = (n: number) => Math.round(n * 100) / 100;
  const nums = values.map((v) => v.value as number);
  const sum = nums.reduce((a, b) => a + b, 0);
  const card = k.aggregate === "sum" ? round(sum) : k.aggregate === "avg" ? round(sum / nums.length) : nums[0];
  let total = 0;
  const points = values
    .slice()
    .reverse()
    .map((v) => ({ at: v.at, value: k.aggregate === "sum" ? round((total += v.value as number)) : (v.value as number) }));
  return { card, series: points.slice(-SERIES_MAX) };
}

/** 新しい順（いつの値か、同じなら番号の大きい方） */
export const byNewest = (a: MetricValue, b: MetricValue) => b.at.localeCompare(a.at) || Number(b.id.slice(1)) - Number(a.id.slice(1));
