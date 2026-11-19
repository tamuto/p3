/**
 * 要求そのものの根拠（出典・確かめた人・確かめた日・根拠）と、Preflight の確認事項（clarify）への回答の規則。
 * CLI・API・画面・Preflight で同じものを使う（保存は core/requestOps.ts と core/preflight/service.ts がこれで確かめる）。
 *
 *   - 実装後の達成の証拠（shared/acceptance.ts の AcceptanceEvidence.basis）や、AI の調べた箇所（PreflightAssessment.evidence）とは別のもの。
 *     「何が正しい要求か」の根拠で、業務の担当が承認した計算例・規則や契約の該当箇所などを書く
 *   - 根拠記録は要望（request.md の requirementSources）と、受け入れ基準ごと（タスク・タスク案の acceptanceSources。criterionId で対応付ける）に持てる。
 *     どれも任意で、無いのは「未記録」。要望の記録を基準が参照すると、そのときの内容を写して参照元の ID（from）を残す。
 *     要望全体の確認を基準に自動で引き継がない（写した記録は未確認から始まる）
 *   - 確かめた人（by）は役割名かアクター名の文字列。氏名・連絡先は求めない。保存した人（recordedBy）とは別に持つ。確かめた日（on）は
 *     利用者が書く YYYY-MM-DD で、保存した日で補わない
 *   - 確認の記録には出典・根拠・確かめた人・確かめた日がそろうことが要る（下書きは出典だけ・対象だけでも保存できる）。
 *     確認したときの対象（要望の題と本文、または基準の文）と記録の対象文・出典・根拠を固定して残し、どれかが変わったら「再確認が必要」。
 *     変わった確認は保存するときに履歴（history）へ移すので、文を元に戻しただけでは確認記録ありに戻らない（もう一度確認を記録する）
 *   - 「確認記録あり」は、申告された確認が今の対象に対応するという意味で、P3 の認証・保証ではない。AI の評価・実装の met・人の済みでは変わらない
 *   - 回答は要望の clarifyAnswers に残す（過去の run と評価は書き換えない）。元の run と確認事項の ID・質問の写しを持つ。回答しただけでは
 *     根拠記録を確認記録ありにしない。次の run の同じ質問へ文字の一致で移さず、元の組のまま資料として渡す
 *   - 直接編集で壊れた値は黙って消さず problems にし、関係のない更新ではファイルの元の値のまま書き戻す（keepRaw）
 */

export const REQUIREMENT_LIMITS = {
  /** 1つの要望・1つのタスクの記録の件数 */
  records: 50,
  /** 対象の要求・前提の文 */
  target: 1000,
  /** 出典（要求元の役割・資料名・版・節） */
  source: 1000,
  /** 根拠の本文（承認された計算例など） */
  basis: 20000,
  /** 確かめた人・回答した人（役割名・アクター名） */
  by: 100,
  /** 回答の件数 */
  answers: 200,
  /** 回答の本文 */
  answer: 20000,
  /** 確認事項の件数（1つの評価） */
  clarifications: 30,
  /** 確認事項の各項目 */
  clarificationText: 2000,
} as const;

/** 確認の記録（確認したときの内容を固定する） */
export interface SourceConfirmation {
  /** 確かめた役割・アクター（例: 経理担当、human:tamuto） */
  by: string;
  /** 確かめた日（YYYY-MM-DD。利用者が書く） */
  on: string;
  /** 確認したときの記録の対象文・出典・根拠 */
  target: string;
  source: string;
  basis: string;
  /** 確認したときの対象（要望の題と本文、基準の文）の hash */
  subject: string;
  recordedAt: string;
  recordedBy?: string;
  /** 対象・内容が変わって効かなくなった日時（履歴の項目だけ） */
  lapsedAt?: string;
}

/** 要求の根拠の記録1件 */
export interface RequirementSource {
  /** 要望・タスクの中で安定した ID（S1, S2, ...） */
  id: string;
  /** 対象の要求・前提の文（基準の記録では省いてよい。対象は基準の文） */
  target?: string;
  /** 出典（誰の要求か・どの資料か。版・節） */
  source?: string;
  /** 根拠の本文（承認された計算例・規則や契約の該当箇所など） */
  basis?: string;
  /** 要望の記録を写したもの（要望の記録の ID） */
  from?: string;
  /** 今の確認の記録 */
  confirmed?: SourceConfirmation;
  /** 前の確認の記録（変わって効かなくなったもの。古い順） */
  history?: SourceConfirmation[];
  recordedAt?: string;
  recordedBy?: string;
}

/** 受け入れ基準の根拠の記録（criterionId で基準に対応付ける） */
export type CriterionSource = RequirementSource & { criterionId: string };

/** 確認の状態。unrecorded: 記録なし / unconfirmed: 未確認 / confirmed: 確認記録あり / reconfirm: 再確認が必要 / unlinked: 対応先不明 */
export type SourceState = "unrecorded" | "unconfirmed" | "confirmed" | "reconfirm" | "unlinked";

export const SOURCE_STATE_LABEL: Record<SourceState, string> = {
  unrecorded: "未記録",
  unconfirmed: "未確認",
  confirmed: "確認記録あり",
  reconfirm: "再確認が必要",
  unlinked: "対応先不明",
};

export const SOURCE_STATE_HINT: Record<SourceState, string> = {
  unrecorded: "出典・根拠の記録がありません",
  unconfirmed: "出典や根拠はあるが、確かめた記録がありません",
  confirmed: "記録した確認が今の内容に対応しています（申告。P3 の保証ではありません）",
  reconfirm: "確認した後で対象か根拠が変わりました。もう一度確かめて記録してください",
  unlinked: "対応する基準・参照元の記録がありません",
};

/** Preflight が clarify で出す確認事項1件（run の中で安定した ID） */
export interface Clarification {
  /** Q1, Q2, ... */
  id: string;
  /** 対象（要望の前提の文、または「D1/A2」のような案と基準） */
  target: string;
  /** 確認先（役割・アクター。分からなければ ASK_UNKNOWN） */
  ask: string;
  question: string;
  /** 必要な根拠（承認された計算例・規則の該当箇所など） */
  needed: string;
  /** 判断への影響 */
  impact: string;
}

/** 確認先が分からないときの確認先 */
export const ASK_UNKNOWN = "要望者に確認先を特定してもらう";

/** 確認事項への回答（要望の clarifyAnswers。1つの確認事項に1件。保存し直すと置き換え） */
export interface ClarifyAnswer {
  /** 元の run */
  run: string;
  /** 元の確認事項の ID */
  question: string;
  /** 回答したときの確認事項の写し */
  copy: { question: string; ask: string; target: string };
  answer: string;
  /** 回答した役割・アクター（保存した人とは別） */
  by?: string;
  /** 回答の日（YYYY-MM-DD） */
  on?: string;
  source?: string;
  basis?: string;
  /** 対応する要望の根拠記録（ID と、回答したときのその記録の内容の hash） */
  links?: { id: string; hash: string }[];
  recordedAt: string;
  recordedBy?: string;
}

/** 回答の状態。answered: 回答済み / unanswered: 未回答 / reconfirm: 対応する記録が変わった / unlinked: 参照元不明 */
export type AnswerState = "answered" | "unanswered" | "reconfirm" | "unlinked";

export const ANSWER_STATE_LABEL: Record<AnswerState, string> = {
  answered: "回答済み",
  unanswered: "未回答",
  reconfirm: "再確認が必要",
  unlinked: "参照元不明",
};

/** 要望の持ち物（Request の一部） */
export interface RequirementState {
  requirementSources?: RequirementSource[];
  /** 振った最後の番号（消した ID を使い直さない） */
  requirementSeq?: number;
  clarifyAnswers?: ClarifyAnswer[];
  /** 直接編集で読めなかった理由（ファイルには書かない。あれば操作で変えない） */
  requirementProblems?: string[];
}

/** ファイルに書く要望の項目（壊れていたら元の値のまま書き戻す） */
export const REQUIREMENT_KEYS = ["requirementSources", "requirementSeq", "clarifyAnswers"] as const;

/** 入力が規則に合わない（何も書いていない）。CLI は使い方の誤り、API は 400 */
export class RequirementInputError extends Error {
  readonly code = "requirement_invalid";
}

export const SOURCE_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 実在する日付か（YYYY-MM-DD） */
export function isDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// --- hash ----------------------------------------------------------------------

/** 依存を足さない短い hash（変わったかを比べるだけ。画面でも同じ値になる） */
export function textHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

const nl = (s: string) => s.replace(/\r\n?/g, "\n").trim();

/** 要望の記録の対象（題と本文）の hash */
export const requestSubject = (r: { title: string; body: string }) => textHash(`request\n${nl(r.title)}\n${nl(r.body)}`);
/** 基準の記録の対象（基準の文）の hash */
export const criterionSubject = (text: string) => textHash(`criterion\n${nl(text)}`);

/** 記録の内容（対象文・出典・根拠）の hash（回答の対応の変化を見る） */
export const sourceContentHash = (s: Pick<RequirementSource, "target" | "source" | "basis">) => textHash(JSON.stringify([s.target ?? "", s.source ?? "", s.basis ?? ""]));

// --- 読む ----------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const opt = (v: unknown) => {
  const s = str(v)?.trim();
  return s ? s : undefined;
};
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === "string" && v ? v : undefined);
/** YAML は日付を Date にしてしまうので YYYY-MM-DD に戻す */
const day = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString().slice(0, 10) : opt(v));

function readConfirmation(v: unknown, at: string): SourceConfirmation | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return `${at} の確認（confirmed）が読めません`;
  const o = v as Record<string, unknown>;
  const by = opt(o.by);
  const on = day(o.on);
  const subject = opt(o.subject);
  if (!by) return `${at} の確認に確かめた人（by）がありません`;
  if (!on || !isDate(on)) return `${at} の確認の日（on）が YYYY-MM-DD ではありません`;
  if (!subject) return `${at} の確認に対象の記録（subject）がありません`;
  return {
    by,
    on,
    target: str(o.target) ?? "",
    source: str(o.source) ?? "",
    basis: str(o.basis) ?? "",
    subject,
    recordedAt: iso(o.recordedAt) ?? new Date(0).toISOString(),
    ...(opt(o.recordedBy) ? { recordedBy: opt(o.recordedBy) } : {}),
    ...(iso(o.lapsedAt) ? { lapsedAt: iso(o.lapsedAt) } : {}),
  };
}

function readSource(raw: unknown, at: string, withCriterion: boolean): CriterionSource | RequirementSource | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${at} が項目になっていません`;
  const o = raw as Record<string, unknown>;
  const id = opt(o.id) ?? "";
  const label = `${at}${id ? `（${id}）` : ""}`;
  if (!SOURCE_ID_RE.test(id)) return `${label} の id が読めません`;
  const criterionId = opt(o.criterionId);
  if (withCriterion && !criterionId) return `${label} の criterionId がありません`;
  const out: RequirementSource & { criterionId?: string } = { id, ...(withCriterion ? { criterionId } : {}) };
  for (const k of ["target", "source", "basis", "from"] as const) {
    const v = o[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" && typeof v !== "number") return `${label} の ${k} が文ではありません`;
    const s = String(v).trim();
    if (s) out[k] = s;
  }
  const tooLong = lengthProblem(out);
  if (tooLong) return `${label}: ${tooLong}`;
  if (o.confirmed !== undefined && o.confirmed !== null) {
    const c = readConfirmation(o.confirmed, label);
    if (typeof c === "string") return c;
    out.confirmed = c;
  }
  if (o.history !== undefined && o.history !== null) {
    if (!Array.isArray(o.history)) return `${label} の history が並びになっていません`;
    const history: SourceConfirmation[] = [];
    for (const h of o.history as unknown[]) {
      const c = readConfirmation(h, `${label} の履歴`);
      if (typeof c === "string") return c;
      history.push(c);
    }
    if (history.length) out.history = history;
  }
  if (iso(o.recordedAt)) out.recordedAt = iso(o.recordedAt);
  if (opt(o.recordedBy)) out.recordedBy = opt(o.recordedBy);
  return out;
}

/** 記録の並びを読む（読めない項目は除いて problems に理由を足す） */
function readSourceList<T extends RequirementSource>(v: unknown, key: string, withCriterion: boolean, problems: string[]): T[] {
  if (!Array.isArray(v)) {
    problems.push(`${key} が並びになっていません`);
    return [];
  }
  const out: T[] = [];
  for (const [i, raw] of (v as unknown[]).entries()) {
    const r = readSource(raw, `根拠の記録 ${i + 1} 件目`, withCriterion);
    if (typeof r === "string") problems.push(r);
    else if (out.some((x) => x.id === r.id)) problems.push(`根拠の記録の id が重複しています: ${r.id}`);
    else out.push(r as T);
  }
  if (out.length > REQUIREMENT_LIMITS.records) problems.push(`根拠の記録は ${REQUIREMENT_LIMITS.records} 件までです（${out.length} 件）`);
  return out;
}

function readAnswer(raw: unknown, at: string): ClarifyAnswer | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${at} が項目になっていません`;
  const o = raw as Record<string, unknown>;
  const run = opt(o.run);
  const question = opt(o.question);
  if (!run || !question) return `${at} に元の run と確認事項の ID（run・question）がありません`;
  const label = `${at}（${run}/${question}）`;
  const answer = opt(o.answer);
  if (!answer) return `${label} の回答（answer）が空です`;
  const copy = o.copy && typeof o.copy === "object" ? (o.copy as Record<string, unknown>) : {};
  const on = day(o.on);
  if (on !== undefined && !isDate(on)) return `${label} の日（on）が YYYY-MM-DD ではありません`;
  let links: ClarifyAnswer["links"];
  if (o.links !== undefined && o.links !== null) {
    if (!Array.isArray(o.links)) return `${label} の links が並びになっていません`;
    links = [];
    for (const l of o.links as unknown[]) {
      const lo = l && typeof l === "object" ? (l as Record<string, unknown>) : {};
      const id = opt(lo.id);
      const hash = opt(lo.hash);
      if (!id || !hash) return `${label} の links の項目が読めません（id・hash が要ります）`;
      links.push({ id, hash });
    }
  }
  return {
    run,
    question,
    copy: { question: str(copy.question) ?? "", ask: str(copy.ask) ?? "", target: str(copy.target) ?? "" },
    answer,
    ...(opt(o.by) ? { by: opt(o.by) } : {}),
    ...(on ? { on } : {}),
    ...(opt(o.source) ? { source: opt(o.source) } : {}),
    ...(opt(o.basis) ? { basis: opt(o.basis) } : {}),
    ...(links?.length ? { links } : {}),
    recordedAt: iso(o.recordedAt) ?? new Date(0).toISOString(),
    ...(opt(o.recordedBy) ? { recordedBy: opt(o.recordedBy) } : {}),
  };
}

/** 要望の frontmatter の値を読む。どれも無ければ何も足さない（古い要望はそのまま） */
export function readRequirement(d: Record<string, unknown>): RequirementState {
  const problems: string[] = [];
  const out: RequirementState = {};
  if (d.requirementSources !== undefined && d.requirementSources !== null) {
    const list = readSourceList<RequirementSource>(d.requirementSources, "requirementSources", false, problems);
    if (list.length) out.requirementSources = list;
  }
  if (d.requirementSeq !== undefined && d.requirementSeq !== null) {
    const n = Number(d.requirementSeq);
    if (Number.isInteger(n) && n >= 0) out.requirementSeq = n;
    else problems.push("requirementSeq が読めません");
  }
  if (d.clarifyAnswers !== undefined && d.clarifyAnswers !== null) {
    if (!Array.isArray(d.clarifyAnswers)) problems.push("clarifyAnswers が並びになっていません");
    else {
      const answers: ClarifyAnswer[] = [];
      for (const [i, raw] of (d.clarifyAnswers as unknown[]).entries()) {
        const a = readAnswer(raw, `回答 ${i + 1} 件目`);
        if (typeof a === "string") problems.push(a);
        else if (answers.some((x) => x.run === a.run && x.question === a.question)) problems.push(`同じ確認事項への回答が重複しています: ${a.run}/${a.question}`);
        else answers.push(a);
      }
      if (answers.length) out.clarifyAnswers = answers;
    }
  }
  if (problems.length) out.requirementProblems = problems;
  return out;
}

/** タスク・タスク案の基準の根拠の記録を読む（acceptanceSources） */
export function readCriterionSources(v: unknown, problems: string[]): CriterionSource[] | undefined {
  if (v === undefined || v === null) return undefined;
  const list = readSourceList<CriterionSource>(v, "acceptanceSources", true, problems);
  return list.length ? list : undefined;
}

// --- 状態 ----------------------------------------------------------------------

/** 確認したときの内容と今が同じか */
function confirmationHolds(c: SourceConfirmation, s: RequirementSource, subject: string): boolean {
  return c.subject === subject && c.target === (s.target ?? "") && c.source === (s.source ?? "") && c.basis === (s.basis ?? "");
}

/**
 * 記録1件の確認の状態。subject: 今の対象の hash（対応する基準が無ければ undefined で対応先不明）。
 * known: 要望の記録の ID（基準の記録の参照元を確かめる。省くと確かめない）
 */
export function sourceState(s: RequirementSource, subject: string | undefined, known?: readonly string[]): SourceState {
  if (subject === undefined) return "unlinked";
  if (s.from && known && !known.includes(s.from)) return "unlinked";
  if (s.confirmed) return confirmationHolds(s.confirmed, s, subject) ? "confirmed" : "reconfirm";
  return s.history?.length ? "reconfirm" : "unconfirmed";
}

/** 対象の記録の並び（無ければ未記録）の状態をまとめる: どれか再確認・対応先不明 → それ、全部確認記録あり → 確認記録あり、ほかは未確認 */
export function overallState(states: readonly SourceState[]): SourceState {
  if (!states.length) return "unrecorded";
  for (const s of ["unlinked", "reconfirm", "unconfirmed"] as const) if (states.includes(s)) return s;
  return "confirmed";
}

/**
 * 保存の前に、効かなくなった確認を履歴へ移す（対象か内容が確認したときと違う）。文を元に戻しても確認記録ありに戻らないようにする
 */
export function settleSources<T extends RequirementSource>(list: readonly T[], subjectOf: (s: T) => string | undefined, now: string): T[] {
  return list.map((s) => {
    const subject = subjectOf(s);
    if (!s.confirmed || subject === undefined || confirmationHolds(s.confirmed, s, subject)) return s;
    const { confirmed, ...rest } = s;
    return { ...rest, history: [...(s.history ?? []), { ...confirmed, lapsedAt: now }] } as T;
  });
}

/** 回答の状態（runs: 今ある run の確認事項。省くと参照元を確かめない） */
export function answerState(a: ClarifyAnswer, sources: readonly RequirementSource[], runs?: ReadonlyMap<string, readonly Clarification[] | undefined>): AnswerState {
  if (runs && !runs.get(a.run)?.some((q) => q.id === a.question)) return "unlinked";
  for (const l of a.links ?? []) {
    const s = sources.find((x) => x.id === l.id);
    if (!s) return "unlinked";
    if (sourceContentHash(s) !== l.hash) return "reconfirm";
  }
  return "answered";
}

/** 確認事項ごとの回答の状態（未回答を含む）。run の確認事項の順 */
export function clarificationStates(
  runId: string,
  clarifications: readonly Clarification[],
  answers: readonly ClarifyAnswer[] | undefined,
  sources: readonly RequirementSource[] | undefined,
): { clarification: Clarification; state: AnswerState; answer?: ClarifyAnswer }[] {
  return clarifications.map((q) => {
    const a = (answers ?? []).find((x) => x.run === runId && x.question === q.id);
    return { clarification: q, state: a ? answerState(a, sources ?? []) : "unanswered", ...(a ? { answer: a } : {}) };
  });
}

// --- 変える --------------------------------------------------------------------

/** 根拠の記録への操作。CLI・API・画面は同じ操作を送る */
export type SourceOp =
  /** 足す。from: 要望の記録を写す（基準の記録だけ）。confirm: 同時に確認を記録する */
  | { op: "add"; target?: string; source?: string; basis?: string; from?: string; confirm?: { by: string; on: string } }
  /** 項目を変える（省いた項目はそのまま、空の文で消す）。内容が変わると確認は再確認が必要になる */
  | { op: "edit"; id: string; target?: string; source?: string; basis?: string; confirm?: { by: string; on: string } }
  /** 今の内容で確認を記録する（出典・根拠・確かめた人・日がそろうこと） */
  | { op: "confirm"; id: string; by: string; on: string }
  | { op: "remove"; id: string };

const FIELD_LABEL = { target: "対象の文", source: "出典", basis: "根拠" } as const;

function lengthProblem(s: Pick<RequirementSource, "target" | "source" | "basis">): string | undefined {
  for (const k of ["target", "source", "basis"] as const) {
    const v = s[k];
    if (v && v.length > REQUIREMENT_LIMITS[k]) return `${FIELD_LABEL[k]}は ${REQUIREMENT_LIMITS[k]} 文字までです（${v.length} 文字）`;
  }
  return undefined;
}

function cleanField(v: unknown, label: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new RequirementInputError(`${label}は文で書いてください`);
  return v.trim();
}

/** 確かめた人・日を確かめる */
export function cleanConfirm(c: { by?: unknown; on?: unknown }, label: string): { by: string; on: string } {
  const by = typeof c.by === "string" ? c.by.trim() : "";
  const on = typeof c.on === "string" ? c.on.trim() : "";
  if (!by) throw new RequirementInputError(`${label}: 確かめた人（役割名かアクター名）を書いてください`);
  if (by.length > REQUIREMENT_LIMITS.by) throw new RequirementInputError(`${label}: 確かめた人は ${REQUIREMENT_LIMITS.by} 文字までです`);
  if (!isDate(on)) throw new RequirementInputError(`${label}: 確かめた日は YYYY-MM-DD で書いてください: ${on || "（空）"}`);
  return { by, on };
}

export interface SourceOpContext {
  now: string;
  actor?: string;
  /** 記録の対象の hash（基準の記録は基準ごと。対象が無ければ undefined） */
  subjectOf: (s: RequirementSource) => string | undefined;
  /** from で写せる要望の記録（基準の記録だけ。要望の記録の操作では渡さない） */
  requestSources?: readonly RequirementSource[];
  /** 新しい記録の ID の採番の起点（今ある記録とこの値の大きい方の次） */
  seq?: number;
  /** 基準の記録なら基準の ID（新しい記録に付ける） */
  criterionId?: string;
}

/** 振った最後の番号 */
export function sourceSeq(list: readonly RequirementSource[], seq = 0): number {
  return list.reduce((n, s) => Math.max(n, /^S(\d+)$/.exec(s.id) ? Number(s.id.slice(1)) : 0), seq);
}

/**
 * 操作を順に当てた後の記録（何も書かない。規則に合わなければ RequirementInputError で、1件も当てない）。
 * 当てた後に、効かなくなった確認を履歴へ移す（settleSources）。同じ値の再保存は元の記録をそのまま残す
 */
export function applySourceOps<T extends RequirementSource>(list: readonly T[], ops: readonly SourceOp[], ctx: SourceOpContext): { list: T[]; seq: number } {
  let out = [...list];
  let seq = sourceSeq(list, ctx.seq ?? 0);
  const find = (id: string) => {
    const s = out.find((x) => x.id === id);
    if (!s) throw new RequirementInputError(`根拠の記録 ${id} はありません${out.length ? `（${out.map((x) => x.id).join(", ")}）` : "（記録がありません）"}`);
    return s;
  };
  const confirmOf = (s: T, c: { by: unknown; on: unknown }): SourceConfirmation => {
    const { by, on } = cleanConfirm(c, `根拠の記録 ${s.id}`);
    const missing = (["source", "basis"] as const).filter((k) => !s[k]);
    if (missing.length) throw new RequirementInputError(`根拠の記録 ${s.id} の確認を記録するには${missing.map((k) => FIELD_LABEL[k]).join("と")}が要ります（下書きは確認なしで保存できます）`);
    const subject = ctx.subjectOf(s);
    if (subject === undefined) throw new RequirementInputError(`根拠の記録 ${s.id} は対応する基準が無いので確認を記録できません`);
    return { by, on, target: s.target ?? "", source: s.source ?? "", basis: s.basis ?? "", subject, recordedAt: ctx.now, ...(ctx.actor ? { recordedBy: ctx.actor } : {}) };
  };
  const withFields = (s: T, f: { target?: unknown; source?: unknown; basis?: unknown }): T => {
    const next = { ...s };
    for (const k of ["target", "source", "basis"] as const) {
      const v = cleanField(f[k], FIELD_LABEL[k]);
      if (v === undefined) continue;
      if (v) next[k] = v;
      else delete next[k];
    }
    const tooLong = lengthProblem(next);
    if (tooLong) throw new RequirementInputError(`根拠の記録 ${s.id}: ${tooLong}`);
    return next;
  };
  const stamp = (s: T): T => ({ ...s, recordedAt: ctx.now, ...(ctx.actor ? { recordedBy: ctx.actor } : {}) });
  const same = (a: T, b: T) => JSON.stringify([a.target, a.source, a.basis, a.from]) === JSON.stringify([b.target, b.source, b.basis, b.from]);
  for (const op of ops) {
    switch (op.op) {
      case "add": {
        if (out.length >= REQUIREMENT_LIMITS.records) throw new RequirementInputError(`根拠の記録は ${REQUIREMENT_LIMITS.records} 件までです`);
        seq += 1;
        let s = { id: `S${seq}`, ...(ctx.criterionId ? { criterionId: ctx.criterionId } : {}) } as unknown as T;
        if (op.from !== undefined) {
          if (!ctx.requestSources) throw new RequirementInputError("要望の記録を写せるのは受け入れ基準の記録だけです");
          const src = ctx.requestSources.find((x) => x.id === op.from);
          if (!src) throw new RequirementInputError(`要望の根拠の記録 ${op.from} はありません`);
          // 写すのは内容だけ（確認は引き継がない）
          s = { ...s, from: src.id, ...(src.target ? { target: src.target } : {}), ...(src.source ? { source: src.source } : {}), ...(src.basis ? { basis: src.basis } : {}) };
        }
        s = withFields(s, op);
        if (!s.target && !s.source && !s.basis) throw new RequirementInputError("根拠の記録には対象の文・出典・根拠のどれかを書いてください");
        s = stamp(s);
        if (op.confirm) s = { ...s, confirmed: confirmOf(s, op.confirm) };
        out.push(s);
        break;
      }
      case "edit": {
        const cur = find(op.id);
        let s = withFields(cur, op);
        if (!s.target && !s.source && !s.basis) throw new RequirementInputError(`根拠の記録 ${op.id} を空にはできません（消すなら remove）`);
        if (!same(cur, s)) s = stamp(s);
        if (op.confirm) {
          // 効かなくなった前の確認は履歴へ
          const settled = settleSources([s], ctx.subjectOf, ctx.now)[0];
          s = { ...settled, confirmed: confirmOf(settled, op.confirm) };
        }
        out = out.map((x) => (x === cur ? s : x));
        break;
      }
      case "confirm": {
        const cur = find(op.id);
        const settled = settleSources([cur], ctx.subjectOf, ctx.now)[0];
        const c = confirmOf(settled, op);
        // 同じ人・日で今も効いている確認の付け直しは何もしない
        if (cur.confirmed && cur.confirmed.by === c.by && cur.confirmed.on === c.on && confirmationHolds(cur.confirmed, cur, c.subject)) break;
        const next = { ...settled, confirmed: c } as T;
        // 効いている確認の付け直し（人・日の訂正）は前の確認を履歴に残す
        if (settled.confirmed) next.history = [...(settled.history ?? []), { ...settled.confirmed, lapsedAt: ctx.now }];
        out = out.map((x) => (x === cur ? next : x));
        break;
      }
      case "remove": {
        const cur = find(op.id);
        out = out.filter((x) => x !== cur);
        break;
      }
      default:
        throw new RequirementInputError(`知らない操作です: ${String((op as { op: unknown }).op)}`);
    }
  }
  return { list: settleSources(out, ctx.subjectOf, ctx.now), seq };
}

/** 保存した記録の比較の鍵（記録の日時・保存者は見ない。確認は人・日・固定した内容を見る） */
export function sourcesKey(list: readonly (RequirementSource & { criterionId?: string })[] | undefined): string {
  const c = (x?: SourceConfirmation) => (x ? [x.by, x.on, x.target, x.source, x.basis, x.subject, x.lapsedAt ?? ""] : null);
  return JSON.stringify((list ?? []).map((s) => [s.criterionId ?? "", s.id, s.target ?? "", s.source ?? "", s.basis ?? "", s.from ?? "", c(s.confirmed), (s.history ?? []).map(c)]));
}

/** 回答の比較の鍵（記録の日時・保存者は見ない） */
export function answersKey(list: readonly ClarifyAnswer[] | undefined): string {
  return JSON.stringify((list ?? []).map((a) => [a.run, a.question, a.copy.question, a.copy.ask, a.copy.target, a.answer, a.by ?? "", a.on ?? "", a.source ?? "", a.basis ?? "", (a.links ?? []).map((l) => `${l.id}:${l.hash}`)]));
}

/** 回答の入力（CLI・API・画面） */
export interface AnswerInput {
  answer: string;
  by?: string;
  on?: string;
  source?: string;
  basis?: string;
  /** 対応する要望の根拠記録の ID */
  links?: string[];
}

/**
 * 回答を確かめて保存する形にする（clarification は元の run の確認事項。写しを持つ）。規則に合わなければ RequirementInputError
 */
export function makeAnswer(runId: string, q: Clarification, input: AnswerInput, sources: readonly RequirementSource[], at: { now: string; actor?: string }): ClarifyAnswer {
  const answer = typeof input.answer === "string" ? input.answer.trim() : "";
  if (!answer) throw new RequirementInputError(`${q.id} の回答が空です`);
  if (answer.length > REQUIREMENT_LIMITS.answer) throw new RequirementInputError(`${q.id} の回答は ${REQUIREMENT_LIMITS.answer} 文字までです（${answer.length} 文字）`);
  const by = input.by?.trim();
  if (by && by.length > REQUIREMENT_LIMITS.by) throw new RequirementInputError(`回答した人は ${REQUIREMENT_LIMITS.by} 文字までです`);
  const on = input.on?.trim();
  if (on && !isDate(on)) throw new RequirementInputError(`回答の日は YYYY-MM-DD で書いてください: ${on}`);
  const source = input.source?.trim();
  if (source && source.length > REQUIREMENT_LIMITS.source) throw new RequirementInputError(`出典は ${REQUIREMENT_LIMITS.source} 文字までです`);
  const basis = input.basis?.trim();
  if (basis && basis.length > REQUIREMENT_LIMITS.basis) throw new RequirementInputError(`根拠は ${REQUIREMENT_LIMITS.basis} 文字までです`);
  const links = [...new Set(input.links ?? [])].map((id) => {
    const s = sources.find((x) => x.id === id);
    if (!s) throw new RequirementInputError(`要望の根拠の記録 ${id} はありません${sources.length ? `（${sources.map((x) => x.id).join(", ")}）` : ""}`);
    return { id, hash: sourceContentHash(s) };
  });
  return {
    run: runId,
    question: q.id,
    copy: { question: q.question, ask: q.ask, target: q.target },
    answer,
    ...(by ? { by } : {}),
    ...(on ? { on } : {}),
    ...(source ? { source } : {}),
    ...(basis ? { basis } : {}),
    ...(links.length ? { links } : {}),
    recordedAt: at.now,
    ...(at.actor ? { recordedBy: at.actor } : {}),
  };
}

/** 回答を足す・置き換える（同じ内容なら元の回答をそのまま残す） */
export function putAnswer(list: readonly ClarifyAnswer[] | undefined, a: ClarifyAnswer): ClarifyAnswer[] {
  const cur = list ?? [];
  const prev = cur.find((x) => x.run === a.run && x.question === a.question);
  if (prev && answersKey([prev]) === answersKey([a])) return [...cur];
  if (!prev && cur.length >= REQUIREMENT_LIMITS.answers) throw new RequirementInputError(`回答は ${REQUIREMENT_LIMITS.answers} 件までです`);
  return prev ? cur.map((x) => (x === prev ? a : x)) : [...cur, a];
}

// --- Preflight の確認事項 ----------------------------------------------------------

/**
 * 評価の clarifications を読む（Codex・手元のエージェントで同じ）。壊れた項目は黙って捨てず problems に理由を返す
 */
export function readClarifications(v: unknown): { clarifications?: Clarification[]; problems?: string[] } {
  if (v === undefined || v === null) return {};
  if (!Array.isArray(v)) return { problems: ["clarifications が並びになっていません"] };
  const problems: string[] = [];
  const out: Clarification[] = [];
  for (const [i, raw] of (v as unknown[]).entries()) {
    const at = `確認事項 ${i + 1} 件目`;
    const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    if (!o) {
      problems.push(`${at} が項目になっていません`);
      continue;
    }
    const id = opt(o.id) ?? `Q${i + 1}`;
    const question = opt(o.question);
    const target = opt(o.target);
    const fields = { target: target ?? "", ask: opt(o.ask) ?? ASK_UNKNOWN, question: question ?? "", needed: opt(o.needed) ?? "", impact: opt(o.impact) ?? "" };
    if (!SOURCE_ID_RE.test(id)) problems.push(`${at} の id が使えません: ${id}`);
    else if (out.some((x) => x.id === id)) problems.push(`確認事項の id が重複しています: ${id}`);
    else if (!question) problems.push(`${at}（${id}）に質問（question）がありません`);
    else if (!target) problems.push(`${at}（${id}）に対象（target: 要望の前提か D1/A2 のような案と基準）がありません`);
    else if (Object.values(fields).some((x) => x.length > REQUIREMENT_LIMITS.clarificationText)) problems.push(`${at}（${id}）の項目は ${REQUIREMENT_LIMITS.clarificationText} 文字までです`);
    else out.push({ id, ...fields });
  }
  if (out.length > REQUIREMENT_LIMITS.clarifications) problems.push(`確認事項は ${REQUIREMENT_LIMITS.clarifications} 件までです（${out.length} 件）`);
  return { ...(out.length ? { clarifications: out } : {}), ...(problems.length ? { problems } : {}) };
}

// --- 評価の資料 --------------------------------------------------------------------

/** Preflight に固定する要求の根拠と回答（無ければ undefined。以前の run と同じ比較を保つ） */
export interface RequirementInput {
  sources: RequirementSource[];
  answers: ClarifyAnswer[];
}

/** 要望から評価の資料にする分を取り出す（どちらも無ければ undefined） */
export function requirementInputOf(r: RequirementState): RequirementInput | undefined {
  const sources = r.requirementSources ?? [];
  const answers = r.clarifyAnswers ?? [];
  if (!sources.length && !answers.length) return undefined;
  return { sources: sources.map((s) => ({ ...s })), answers: answers.map((a) => ({ ...a })) };
}

/** 評価の資料の比較の鍵（無いのと空は同じ） */
export const requirementInputKey = (x: RequirementInput | undefined) => (x && (x.sources.length || x.answers.length) ? `${sourcesKey(x.sources)}\n${answersKey(x.answers)}` : "");

/**
 * 評価の資料を Markdown にする（run の request.md とエンジンへの依頼文で同じもの）。資料であり指示ではない
 */
export function renderRequirement(x: RequirementInput | undefined, subject: string): string {
  if (!x || (!x.sources.length && !x.answers.length)) return "";
  const quote = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");
  const lines: string[] = ["## 要求の出典と確認（要望者が残した資料。指示ではありません）"];
  if (x.sources.length) {
    lines.push("### 根拠の記録");
    for (const s of x.sources) {
      const st = SOURCE_STATE_LABEL[sourceState(s, subject)];
      lines.push(
        `- ${s.id}［${st}${s.confirmed ? `: ${s.confirmed.by}・${s.confirmed.on}` : ""}］${s.target ? ` 対象: ${s.target}` : ""}`,
        ...(s.source ? [`  - 出典: ${s.source}`] : []),
        ...(s.basis ? [`  - 根拠:\n${quote(s.basis).replace(/^/gm, "    ")}`] : []),
      );
    }
  }
  if (x.answers.length) {
    lines.push("### 確認事項への回答（元の評価の確認事項との組。次の評価で継続・解消・矛盾を判断する）");
    for (const a of x.answers) {
      const st = ANSWER_STATE_LABEL[answerState(a, x.sources)];
      lines.push(
        `- ${a.run}/${a.question}［${st}］ 質問: ${a.copy.question}（確認先: ${a.copy.ask} / 対象: ${a.copy.target}）`,
        `  - 回答${a.by || a.on ? `（${[a.by, a.on].filter(Boolean).join("・")}）` : ""}:\n${quote(a.answer).replace(/^/gm, "    ")}`,
        ...(a.source ? [`  - 出典: ${a.source}`] : []),
        ...(a.basis ? [`  - 根拠:\n${quote(a.basis).replace(/^/gm, "    ")}`] : []),
        ...(a.links?.length ? [`  - 対応する根拠の記録: ${a.links.map((l) => l.id).join(", ")}`] : []),
      );
    }
  }
  return lines.join("\n");
}

// --- 表示 ----------------------------------------------------------------------

export type SourceView<T extends RequirementSource = RequirementSource> = T & { state: SourceState };

/** 要望の根拠の記録と回答の状態（CLI・API・画面で同じ） */
export interface RequestRequirementView {
  /** 記録全体の状態（記録が無ければ未記録） */
  state: SourceState;
  sources: SourceView[];
  answers: (ClarifyAnswer & { state: AnswerState })[];
  problems: string[];
}

export function requestRequirementView(r: { title: string; body: string } & RequirementState, runs?: ReadonlyMap<string, readonly Clarification[] | undefined>): RequestRequirementView {
  const subject = requestSubject(r);
  const sources = (r.requirementSources ?? []).map((s) => ({ ...s, state: sourceState(s, subject) }));
  const answers = (r.clarifyAnswers ?? []).map((a) => ({ ...a, state: answerState(a, r.requirementSources ?? [], runs) }));
  return { state: overallState(sources.map((s) => s.state)), sources, answers, problems: r.requirementProblems ?? [] };
}

/** 基準ごとの根拠の記録の状態（基準の順）と、対応する基準の無い記録 */
export interface CriteriaSourceView {
  items: { id: string; text: string; state: SourceState; sources: SourceView<CriterionSource>[] }[];
  /** 対応先不明（基準を消した・参照元の要望の記録が無い） */
  orphans: SourceView<CriterionSource>[];
}

export function criteriaSourceView(
  criteria: readonly { id: string; text: string }[] | undefined,
  sources: readonly CriterionSource[] | undefined,
  requestSourceIds?: readonly string[],
): CriteriaSourceView {
  const list = sources ?? [];
  const items = (criteria ?? []).map((c) => {
    const subject = criterionSubject(c.text);
    const mine = list.filter((s) => s.criterionId === c.id).map((s) => ({ ...s, state: sourceState(s, subject, requestSourceIds) }));
    return { id: c.id, text: c.text, state: overallState(mine.map((s) => s.state)), sources: mine };
  });
  const ids = new Set((criteria ?? []).map((c) => c.id));
  const orphans = list.filter((s) => !ids.has(s.criterionId)).map((s) => ({ ...s, state: "unlinked" as const }));
  return { items, orphans };
}
