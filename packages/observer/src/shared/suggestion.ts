import { isRecord, migrateProcedures, validateDefinitionInput, type DefinitionProblem, type Measure, type Procedure } from "./definition.ts";
import { validatePreparationInput, type PreparationInput, type Slot } from "./preparation.ts";

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

/**
 * 前提の観測と使う準備の候補（このプロジェクトのもの。判断に要る項目だけ）。保存した観測に頼むときに P3 が保存の層から作り、依頼と一緒に残す。
 * 観測は自分自身と、前提をたどると自分に戻るもの（選ぶと循環するもの）を除く
 */
export interface SuggestionCandidates {
  observations: { id: string; title: string; description: string }[];
  preparations: { id: string; name: string; description?: string; exclusive: string[]; slots: Slot[] }[];
}

/** 提案の依頼（未保存の定義の入力・任意の補足）。参照先は Preflight と同じく、読めるものを全部渡す（選ばない） */
export interface SuggestionRequest {
  /** 定義の入力（未保存。手順は空でもよい） */
  definition: { title: string; category: string; description: string; expected?: string; prerequisites?: string[]; preparations?: string[]; measures: Measure[]; procedures: Procedure[] };
  /** 補足（足りない材料への答えなど） */
  note?: string;
  /** 前提の観測と使う準備の候補（P3 が付ける。利用者の入力では渡せない） */
  candidates?: SuggestionCandidates;
}

/** 提案された手順と、そう判断した根拠 */
export interface SuggestedProcedure {
  procedure: Procedure;
  evidence: string;
}

export interface Suggestion {
  surface: Surface;
  /** 測定項目の候補（定義に無いものだけ。取り込むと手順から参照できる） */
  measures: Measure[];
  /** 操作面と手順をそう判断した根拠 */
  rationale: string;
  procedures: SuggestedProcedure[];
  /** 前提の観測の候補（候補の中の観測の ID）と、再利用する既存の準備（候補の中の準備の ID）。理由つき */
  prerequisites: { id: string; reason: string }[];
  preparations: { id: string; reason: string }[];
  /** 既にある準備に合うものが無いときの、新しい準備の案（登録の画面で確かめて保存してから観測に足す） */
  newPreparations: { preparation: PreparationInput; reason: string }[];
  /** 判断に足りない材料（無ければ空） */
  missing: { field: MissingField; reason: string }[];
  /** 応答を読むときに理由を付けて外したもの（名前の衝突・定義にも候補にも無い測定項目の参照など） */
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

/** 依頼の入力を確かめる（定義の入力は手順の提案の材料なので、タイトルか観測内容のどちらかがあればよい） */
export function validateSuggestionRequest(input: unknown): { ok: true; value: SuggestionRequest } | { ok: false; problems: DefinitionProblem[] } {
  if (!isRecord(input)) return { ok: false, problems: [{ path: "", message: "依頼は JSON のオブジェクトで渡してください（definition・note）" }] };
  const problems: DefinitionProblem[] = [];
  for (const k of Object.keys(input)) if (!["definition", "note"].includes(k)) problems.push({ path: k, message: "知らない項目です（definition・note）" });
  const d = isRecord(input.definition) ? input.definition : {};
  // 必須の項目が空でも材料にはなるので、空のものは仮の値で検証し、測定項目・手順の形だけを確かめる
  const filled = (v: unknown) => (typeof v === "string" && v.trim() ? v : "（未入力）");
  const v = validateDefinitionInput({ title: filled(d.title), category: filled(d.category), description: filled(d.description), expected: d.expected, prerequisites: d.prerequisites, preparations: d.preparations, measures: d.measures ?? [], procedures: d.procedures ?? [] });
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
      definition: { ...v.value, title: text(d.title), category: text(d.category), description: text(d.description) },
      ...(note ? { note } : {}),
    },
  };
}

/** 応答の形が違う */
export class InvalidSuggestion extends Error {}

/**
 * AI の応答（最後の文）から提案を読む。JSON（コードブロックの中でもよい）で、測定項目の候補と手順は定義と同じ検証を通す。
 * 定義に既にある名前の候補は外し、定義にも候補にも無い測定項目の参照は外して、どちらも理由を warnings に書く。形が違えば InvalidSuggestion
 */
export function parseSuggestion(message: string, measures: Measure[], choices?: SuggestionCandidates): Suggestion {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(message)?.[1];
  const src = fenced ?? message;
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start < 0 || end < start) throw new InvalidSuggestion("応答に JSON がありません");
  let data: unknown;
  try {
    data = JSON.parse(src.slice(start, end + 1));
  } catch (e) {
    throw new InvalidSuggestion(`応答の JSON を読めません（${(e as Error).message}）`);
  }
  if (!isRecord(data)) throw new InvalidSuggestion("応答がオブジェクトではありません");
  const surface = (SURFACES as readonly unknown[]).includes(data.surface) ? (data.surface as Surface) : undefined;
  if (!surface) throw new InvalidSuggestion(`surface が ${SURFACES.join(" / ")} のどれでもありません`);
  if (typeof data.rationale !== "string" || !data.rationale.trim()) throw new InvalidSuggestion("判断の根拠（rationale）がありません");
  for (const k of ["procedures", "missing"]) if (!Array.isArray(data[k])) throw new InvalidSuggestion(`${k} が配列ではありません`);
  if (data.measures !== undefined && !Array.isArray(data.measures)) throw new InvalidSuggestion("measures が配列ではありません");
  const warnings: string[] = [];
  const have = new Set(measures.map((m) => m.name));
  const candidates: Measure[] = [];
  for (const [i, raw] of ((data.measures as unknown[] | undefined) ?? []).entries()) {
    const v = validateDefinitionInput({ title: "提案", description: "提案", measures: [raw] });
    if (!v.ok) throw new InvalidSuggestion(`measures[${i}] が測定項目の形に合いません（${v.problems.map((p) => `${p.path.replace(/^measures\[0\]\.?/, "")}: ${p.message}`).join("・")}）`);
    const m = v.value.measures[0];
    if (have.has(m.name)) warnings.push(`測定項目の候補 ${m.name} は定義に同じ名前があるので外しました`);
    else if (candidates.some((c) => c.name === m.name)) warnings.push(`測定項目の候補 ${m.name} が重なっているので1つにしました`);
    else candidates.push(m);
  }
  const all = [...measures, ...candidates];
  const names = new Set(all.map((m) => m.name));
  const procedures: SuggestedProcedure[] = (data.procedures as unknown[]).map((raw, i) => {
    if (!isRecord(raw)) throw new InvalidSuggestion(`procedures[${i}] がオブジェクトではありません`);
    const { evidence, id: _id, ...rest } = raw;
    if (typeof evidence !== "string" || !evidence.trim()) throw new InvalidSuggestion(`procedures[${i}] の根拠（evidence）がありません`);
    const refs = Array.isArray(rest.measures) ? rest.measures : [];
    const kept = refs.filter((r) => typeof r === "string" && names.has(r));
    for (const r of refs) if (!kept.includes(r)) warnings.push(`手順 ${i + 1} の測定項目 ${String(r)} は定義にも候補にも無いので外しました`);
    const v = validateDefinitionInput({ title: "提案", description: "提案", measures: all, procedures: [{ ...rest, measures: kept }] });
    if (!v.ok) throw new InvalidSuggestion(`procedures[${i}] が手順の形に合いません（${v.problems.map((p) => `${p.path.replace(/^procedures\[0\]\.?/, "")}: ${p.message}`).join("・")}）`);
    return { procedure: v.value.procedures[0], evidence: evidence.trim() };
  });
  const missing = (data.missing as unknown[]).map((raw, i) => {
    if (!isRecord(raw) || typeof raw.reason !== "string" || !raw.reason.trim()) throw new InvalidSuggestion(`missing[${i}] に理由（reason）がありません`);
    const field = (MISSING_FIELDS as readonly unknown[]).includes(raw.field) ? (raw.field as MissingField) : "other";
    return { field, reason: raw.reason.trim() };
  });
  const refs = parseRefs(data, choices, warnings);
  if (!procedures.length && !missing.length && !candidates.length && !refs.prerequisites.length && !refs.preparations.length && !refs.newPreparations.length) {
    throw new InvalidSuggestion("手順の提案も、測定項目・前提・準備の候補も、足りない材料もありません");
  }
  return { surface, rationale: data.rationale.trim(), measures: candidates, procedures, ...refs, missing, warnings };
}

/**
 * 前提の観測・再利用する準備・新しい準備の案を読む（どれも任意）。候補に無い観測と準備は外し（循環する前提は候補に入っていない）、
 * 既にある準備と同じ名前の新しい案は、その準備の再利用にする。どれも理由を warnings に書く
 */
function parseRefs(data: Record<string, unknown>, c: SuggestionCandidates | undefined, warnings: string[]): Pick<Suggestion, "prerequisites" | "preparations" | "newPreparations"> {
  const list = (k: string) => {
    if (data[k] !== undefined && !Array.isArray(data[k])) throw new InvalidSuggestion(`${k} が配列ではありません`);
    return ((data[k] as unknown[] | undefined) ?? []).map((raw, i) => {
      if (!isRecord(raw) || typeof raw.reason !== "string" || !raw.reason.trim()) throw new InvalidSuggestion(`${k}[${i}] に理由（reason）がありません`);
      return { raw, reason: raw.reason.trim() };
    });
  };
  const out: Pick<Suggestion, "prerequisites" | "preparations" | "newPreparations"> = { prerequisites: [], preparations: [], newPreparations: [] };
  const reuse = (id: string, reason: string) => !out.preparations.some((p) => p.id === id) && out.preparations.push({ id, reason });
  for (const { raw, reason } of list("prerequisites")) {
    const hit = c?.observations.find((o) => o.id === raw.id);
    if (!hit) warnings.push(`前提の候補 ${String(raw.id)} は選べる観測に無い（存在しない・自分自身・循環する）ので外しました`);
    else if (!out.prerequisites.some((p) => p.id === hit.id)) out.prerequisites.push({ id: hit.id, reason });
  }
  for (const { raw, reason } of list("preparations")) {
    const hit = c?.preparations.find((p) => p.id === raw.id || p.name === raw.id);
    if (hit) reuse(hit.id, reason);
    else warnings.push(`準備の候補 ${String(raw.id)} は既にある準備に無いので外しました`);
  }
  for (const [i, { raw, reason }] of list("newPreparations").entries()) {
    const v = validatePreparationInput(raw.preparation);
    if (!v.ok) throw new InvalidSuggestion(`newPreparations[${i}] が準備の形に合いません（${v.problems.map((p) => `${p.path}: ${p.message}`).join("・")}）`);
    const same = c?.preparations.find((p) => p.name === v.value.name);
    if (same) {
      warnings.push(`新しい準備の案「${v.value.name}」は同じ名前の準備が既にあるので、その準備を使う候補にしました`);
      reuse(same.id, reason);
    } else out.newPreparations.push({ preparation: v.value, reason });
  }
  return out;
}

/** 形の版 1 のときに保存した提案（手順に kind を直に持つ）を今の形で読む */
export function migrateSuggestion<T extends { result?: Suggestion; request?: SuggestionRequest }>(j: T): T {
  const result = j.result && {
    ...j.result,
    measures: j.result.measures ?? [],
    prerequisites: j.result.prerequisites ?? [],
    preparations: j.result.preparations ?? [],
    newPreparations: j.result.newPreparations ?? [],
    procedures: j.result.procedures.map((p) => ({ ...p, procedure: { ...(migrateProcedures([p.procedure]) as Procedure[])[0], id: "" } })),
  };
  const request = j.request && { ...j.request, definition: { ...j.request.definition, procedures: migrateProcedures(j.request.definition.procedures) as Procedure[] } };
  return { ...j, ...(result ? { result } : {}), ...(request ? { request } : {}) };
}
