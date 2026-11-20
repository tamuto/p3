import { validateDefinitionInput, type DefinitionProblem, type Measure, type Procedure } from "./definition.ts";

/**
 * 観測の定義の入力から、AI に確認の手順を提案してもらう（docs/architecture.md「p3-observer」の手順の提案）。
 * 提案は入力用のデータで、保存しない（取り込んで保存するのは利用者の明示の操作。保存のときは定義の検証が働く）。
 * 手順の実行・テストのファイルの作成・結果の保存はしない。
 */

/** 観測の対象の操作面 */
export const SURFACES = ["cli", "ui", "api", "library", "unknown"] as const;
export type Surface = (typeof SURFACES)[number];
export const SURFACE_LABEL: Record<Surface, string> = { cli: "CLI・コマンド", ui: "画面", api: "API", library: "ライブラリ・関数", unknown: "判断できない" };

/** 判断に足りない材料の種類（利用者が補足して頼み直す） */
export const MISSING_FIELDS = ["surface", "target", "entry", "repo", "measure", "other"] as const;
export type MissingField = (typeof MISSING_FIELDS)[number];
export const MISSING_LABEL: Record<MissingField, string> = {
  surface: "操作面（CLI・画面・API など）",
  target: "対象の画面やコマンド",
  entry: "入口の手がかり（URL・起動方法・コマンド名・ファイル）",
  repo: "参照先（読ませるリポジトリ）",
  measure: "測定項目",
  other: "そのほか",
};

/** 提案の依頼（未保存の定義の入力・任意の補足）。参照先は Preflight と同じく、読めるものを全部渡す（選ばない） */
export interface SuggestionRequest {
  /** 定義の入力（未保存。手順は空でもよい） */
  definition: { title: string; category: string; description: string; measures: Measure[]; procedures: Procedure[] };
  /** 補足（足りない材料への答えなど） */
  note?: string;
}

/** 提案された手順と、そう判断した根拠 */
export interface SuggestedProcedure {
  procedure: Procedure;
  evidence: string;
}

export interface Suggestion {
  surface: Surface;
  /** 操作面と手順をそう判断した根拠 */
  rationale: string;
  procedures: SuggestedProcedure[];
  /** 判断に足りない材料（無ければ空） */
  missing: { field: MissingField; reason: string }[];
  /** 応答を読むときに落としたもの（定義に無い測定項目の参照など） */
  warnings: string[];
}

/** interrupted: 実行していたプロセスが終わっている（強制終了など）。同じ入力で頼み直せる */
export type SuggestionStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
/** 失敗の種類: unavailable 接続が使えない / usage_limit 使用量の上限 / invalid_output 応答の形の不備 / timeout 時間切れ / error そのほか */
export type SuggestionFailure = "unavailable" | "usage_limit" | "invalid_output" | "timeout" | "error";

/** 提案の実行。観測の ID に結び付けたものは observer/work/<ID>/suggestions/ に保存する（ID の無い互換の経路はこのプロセスの中だけ） */
export interface SuggestionJob {
  id: string;
  /** 観測の ID と、頼んだときの定義の版・依頼（保存したものだけ） */
  definition?: string;
  basedOnRev?: number;
  request?: SuggestionRequest;
  /** 頼むときに渡した文脈（品質基準の版と、読ませた参照先のパス） */
  context?: { qualityVersion?: string; repos: string[] };
  /** 実行しているプロセス（同じマシンでプロセスが終わっていれば interrupted と読む） */
  owner?: { host: string; pid: number };
  status: SuggestionStatus;
  engine: string;
  startedAt: string;
  finishedAt?: string;
  result?: Suggestion;
  failure?: SuggestionFailure;
  error?: string;
}

/** 提案の材料の状態: 頼む先が使えるか・プロジェクトの参照先（読めるものは全部 AI に渡す） */
export interface SuggestionContext {
  engine: { name: string; ok: boolean; detail: string };
  /** path は AI のコンテナの中で読めるパス（読むだけのマウント。読めない参照先は渡さない） */
  repos: { name: string; available: boolean; reason?: string; path?: string }[];
  /** Preflight と同じ組み立てのプロジェクトの文脈（プロジェクトの説明・参照先と役割・最初に読むもの・主なフォルダ・品質基準・調べ方） */
  project?: string;
  /** 文脈に入れた品質基準の版 */
  qualityVersion?: string;
}

/** 入口のアダプター（Codex の接続など）が投げる失敗。kind で画面と CLI に理由の種類を出す */
export class SuggestionError extends Error {
  constructor(
    readonly kind: SuggestionFailure,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 依頼の入力を確かめる（定義の入力は手順の提案の材料なので、タイトルか観測内容のどちらかがあればよい） */
export function validateSuggestionRequest(input: unknown): { ok: true; value: SuggestionRequest } | { ok: false; problems: DefinitionProblem[] } {
  if (!isRecord(input)) return { ok: false, problems: [{ path: "", message: "依頼は JSON のオブジェクトで渡してください（definition・note）" }] };
  const problems: DefinitionProblem[] = [];
  for (const k of Object.keys(input)) if (!["definition", "note"].includes(k)) problems.push({ path: k, message: "知らない項目です（definition・note）" });
  const d = isRecord(input.definition) ? input.definition : {};
  // 必須の項目が空でも材料にはなるので、空のものは仮の値で検証し、測定項目・手順の形だけを確かめる
  const filled = (v: unknown) => (typeof v === "string" && v.trim() ? v : "（未入力）");
  const v = validateDefinitionInput({ title: filled(d.title), category: filled(d.category), description: filled(d.description), measures: d.measures ?? [], procedures: d.procedures ?? [] });
  if (!v.ok) problems.push(...v.problems.map((p) => ({ ...p, path: `definition.${p.path}` })));
  const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");
  if (!text(d.title) && !text(d.description)) problems.push({ path: "definition.description", message: "提案の材料に、タイトルか観測内容を入力してください" });
  if (input.note !== undefined && typeof input.note !== "string") problems.push({ path: "note", message: "補足は文字列で渡してください" });
  if (typeof input.note === "string" && input.note.length > 5000) problems.push({ path: "note", message: "補足は 5000 文字以内にしてください" });
  if (problems.length || !v.ok) return { ok: false, problems };
  const note = text(input.note);
  return {
    ok: true,
    value: {
      definition: { title: text(d.title), category: text(d.category), description: text(d.description), measures: v.value.measures, procedures: v.value.procedures },
      ...(note ? { note } : {}),
    },
  };
}

/** 応答の形が違う */
export class InvalidSuggestion extends Error {}

/**
 * AI の応答（最後の文）から提案を読む。JSON（コードブロックの中でもよい）で、手順は定義と同じ検証を通す。
 * 定義に無い測定項目の参照は落として warnings に書く。形が違えば InvalidSuggestion
 */
export function parseSuggestion(message: string, measures: Measure[]): Suggestion {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(message)?.[1];
  const start = (fenced ?? message).indexOf("{");
  const end = (fenced ?? message).lastIndexOf("}");
  if (start < 0 || end < start) throw new InvalidSuggestion("応答に JSON がありません");
  let data: unknown;
  try {
    data = JSON.parse((fenced ?? message).slice(start, end + 1));
  } catch (e) {
    throw new InvalidSuggestion(`応答の JSON を読めません（${(e as Error).message}）`);
  }
  if (!isRecord(data)) throw new InvalidSuggestion("応答がオブジェクトではありません");
  const surface = (SURFACES as readonly unknown[]).includes(data.surface) ? (data.surface as Surface) : undefined;
  if (!surface) throw new InvalidSuggestion(`surface が ${SURFACES.join(" / ")} のどれでもありません`);
  if (typeof data.rationale !== "string" || !data.rationale.trim()) throw new InvalidSuggestion("判断の根拠（rationale）がありません");
  if (!Array.isArray(data.procedures)) throw new InvalidSuggestion("procedures が配列ではありません");
  if (!Array.isArray(data.missing)) throw new InvalidSuggestion("missing が配列ではありません");
  const names = new Set(measures.map((m) => m.name));
  const warnings: string[] = [];
  const procedures: SuggestedProcedure[] = data.procedures.map((raw, i) => {
    if (!isRecord(raw)) throw new InvalidSuggestion(`procedures[${i}] がオブジェクトではありません`);
    const { evidence, ...rest } = raw;
    if (typeof evidence !== "string" || !evidence.trim()) throw new InvalidSuggestion(`procedures[${i}] の根拠（evidence）がありません`);
    const refs = Array.isArray(rest.measures) ? rest.measures : [];
    const kept = refs.filter((r) => typeof r === "string" && names.has(r));
    for (const r of refs) if (!kept.includes(r)) warnings.push(`手順 ${i + 1} の測定項目 ${String(r)} は定義に無いので外しました`);
    const v = validateDefinitionInput({ title: "提案", category: "提案", description: "提案", measures, procedures: [{ ...rest, measures: kept }] });
    if (!v.ok) throw new InvalidSuggestion(`procedures[${i}] が手順の形に合いません（${v.problems.map((p) => `${p.path.replace(/^procedures\[0\]\.?/, "")}: ${p.message}`).join("・")}）`);
    return { procedure: v.value.procedures[0], evidence: evidence.trim() };
  });
  const missing = data.missing.map((raw, i) => {
    if (!isRecord(raw) || typeof raw.reason !== "string" || !raw.reason.trim()) throw new InvalidSuggestion(`missing[${i}] に理由（reason）がありません`);
    const field = (MISSING_FIELDS as readonly unknown[]).includes(raw.field) ? (raw.field as MissingField) : "other";
    return { field, reason: raw.reason.trim() };
  });
  if (!procedures.length && !missing.length) throw new InvalidSuggestion("手順の提案も、足りない材料もありません");
  return { surface, rationale: data.rationale.trim(), procedures, missing, warnings };
}
