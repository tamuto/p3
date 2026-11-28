/**
 * Preflight の確認事項（clarify）と、その回答の規則。CLI・API・画面・Preflight で同じものを使う
 * （保存は core/requestOps.ts と core/preflight/service.ts がこれで確かめる）。
 *
 *   - 回答は要望の clarifyAnswers に残す（過去の run と評価は書き換えない）。持つのは元の run と確認事項の ID・質問の写し・回答・回答した人・日だけ。
 *     次の run の同じ質問へ文字の一致で移さず、元の組のまま資料として渡す
 *   - 状態は 回答済み・未回答 の2つ。質問は回答に写してあるので、元の run が無くても読める
 *   - 以前の版の回答の出典（source）・根拠（basis）・対応する記録（links）は読むときに無視する（評価対象の比較にも入れない）
 *   - 直接編集で壊れた値は黙って消さず problems にし、関係のない更新ではファイルの元の値のまま書き戻す（keepRaw）
 */

export const CLARIFY_LIMITS = {
  /** 回答した人（役割名・アクター名） */
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
  recordedAt: string;
  recordedBy?: string;
}

export type AnswerState = "answered" | "unanswered";
export const ANSWER_STATE_LABEL: Record<AnswerState, string> = { answered: "回答済み", unanswered: "未回答" };

/** 要望の持ち物（Request の一部） */
export interface RequirementState {
  clarifyAnswers?: ClarifyAnswer[];
  /** 直接編集で読めなかった理由（ファイルには書かない。あれば操作で変えない） */
  requirementProblems?: string[];
}

/** ファイルに書く要望の項目（壊れていたら元の値のまま書き戻す） */
export const REQUIREMENT_KEYS = ["clarifyAnswers"] as const;

/** 入力が規則に合わない（何も書いていない）。CLI は使い方の誤り、API は 400 */
export class RequirementInputError extends Error {
  readonly code = "requirement_invalid";
}

const ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 実在する日付か（YYYY-MM-DD） */
export function isDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// --- 読む ----------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const opt = (v: unknown) => {
  const s = str(v)?.trim();
  return s ? s : undefined;
};
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === "string" && v ? v : undefined);
/** YAML は日付を Date にしてしまうので YYYY-MM-DD に戻す */
const day = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString().slice(0, 10) : opt(v));

/** 回答を1件読む（以前の版の source・basis・links は無視する） */
export function readAnswer(raw: unknown, at: string): ClarifyAnswer | string {
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
  return {
    run,
    question,
    copy: { question: opt(copy.question) ?? "", ask: opt(copy.ask) ?? "", target: opt(copy.target) ?? "" },
    answer,
    ...(opt(o.by) ? { by: opt(o.by) } : {}),
    ...(on ? { on } : {}),
    recordedAt: iso(o.recordedAt) ?? new Date(0).toISOString(),
    ...(opt(o.recordedBy) ? { recordedBy: opt(o.recordedBy) } : {}),
  };
}

/** 要望の frontmatter の回答を読む。無ければ何も足さない（古い要望はそのまま） */
export function readRequirement(d: Record<string, unknown>): RequirementState {
  if (d.clarifyAnswers === undefined || d.clarifyAnswers === null) return {};
  if (!Array.isArray(d.clarifyAnswers)) return { requirementProblems: ["clarifyAnswers が並びになっていません"] };
  const problems: string[] = [];
  const answers: ClarifyAnswer[] = [];
  for (const [i, raw] of (d.clarifyAnswers as unknown[]).entries()) {
    const a = readAnswer(raw, `回答 ${i + 1} 件目`);
    if (typeof a === "string") problems.push(a);
    else if (answers.some((x) => x.run === a.run && x.question === a.question)) problems.push(`同じ確認事項への回答が重複しています: ${a.run}/${a.question}`);
    else answers.push(a);
  }
  return { ...(answers.length ? { clarifyAnswers: answers } : {}), ...(problems.length ? { requirementProblems: problems } : {}) };
}

/** 確認事項ごとの回答の状態（未回答を含む）。run の確認事項の順 */
export function clarificationStates(runId: string, clarifications: readonly Clarification[], answers: readonly ClarifyAnswer[] | undefined): { clarification: Clarification; state: AnswerState; answer?: ClarifyAnswer }[] {
  return clarifications.map((q) => {
    const a = (answers ?? []).find((x) => x.run === runId && x.question === q.id);
    return { clarification: q, state: a ? "answered" : "unanswered", ...(a ? { answer: a } : {}) };
  });
}

// --- 変える --------------------------------------------------------------------

/** 回答の比較の鍵（記録の日時・保存者は見ない） */
export function answersKey(list: readonly ClarifyAnswer[] | undefined): string {
  return JSON.stringify((list ?? []).map((a) => [a.run, a.question, a.copy.question, a.copy.ask, a.copy.target, a.answer, a.by ?? "", a.on ?? ""]));
}

/** 回答の入力（CLI・API・画面） */
export interface AnswerInput {
  answer: string;
  by?: string;
  on?: string;
}

/** 回答を確かめて保存する形にする（q は元の run の確認事項。写しを持つ）。規則に合わなければ RequirementInputError */
export function makeAnswer(runId: string, q: Clarification, input: AnswerInput, at: { now: string; actor?: string }): ClarifyAnswer {
  const answer = typeof input.answer === "string" ? input.answer.trim() : "";
  if (!answer) throw new RequirementInputError(`${q.id} の回答が空です`);
  if (answer.length > CLARIFY_LIMITS.answer) throw new RequirementInputError(`${q.id} の回答は ${CLARIFY_LIMITS.answer} 文字までです（${answer.length} 文字）`);
  const by = input.by?.trim();
  if (by && by.length > CLARIFY_LIMITS.by) throw new RequirementInputError(`回答した人は ${CLARIFY_LIMITS.by} 文字までです`);
  const on = input.on?.trim();
  if (on && !isDate(on)) throw new RequirementInputError(`回答の日は YYYY-MM-DD で書いてください: ${on}`);
  return {
    run: runId,
    question: q.id,
    copy: { question: q.question, ask: q.ask, target: q.target },
    answer,
    ...(by ? { by } : {}),
    ...(on ? { on } : {}),
    recordedAt: at.now,
    ...(at.actor ? { recordedBy: at.actor } : {}),
  };
}

/** 回答を足す・置き換える（同じ内容なら元の回答をそのまま残す） */
export function putAnswer(list: readonly ClarifyAnswer[] | undefined, a: ClarifyAnswer): ClarifyAnswer[] {
  const cur = list ?? [];
  const prev = cur.find((x) => x.run === a.run && x.question === a.question);
  if (prev && answersKey([prev]) === answersKey([a])) return [...cur];
  if (!prev && cur.length >= CLARIFY_LIMITS.answers) throw new RequirementInputError(`回答は ${CLARIFY_LIMITS.answers} 件までです`);
  return prev ? cur.map((x) => (x === prev ? a : x)) : [...cur, a];
}

// --- Preflight の確認事項 ----------------------------------------------------------

/** 評価の clarifications を読む（Codex・手元のエージェントで同じ）。壊れた項目は黙って捨てず problems に理由を返す */
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
    if (!ID_RE.test(id)) problems.push(`${at} の id が使えません: ${id}`);
    else if (out.some((x) => x.id === id)) problems.push(`確認事項の id が重複しています: ${id}`);
    else if (!question) problems.push(`${at}（${id}）に質問（question）がありません`);
    else if (!target) problems.push(`${at}（${id}）に対象（target: 要望の前提か D1/A2 のような案と基準）がありません`);
    else if (Object.values(fields).some((x) => x.length > CLARIFY_LIMITS.clarificationText)) problems.push(`${at}（${id}）の項目は ${CLARIFY_LIMITS.clarificationText} 文字までです`);
    else out.push({ id, ...fields });
  }
  if (out.length > CLARIFY_LIMITS.clarifications) problems.push(`確認事項は ${CLARIFY_LIMITS.clarifications} 件までです（${out.length} 件）`);
  return { ...(out.length ? { clarifications: out } : {}), ...(problems.length ? { problems } : {}) };
}

// --- 評価の資料 --------------------------------------------------------------------

/** Preflight に固定する回答（無ければ undefined）。以前の run の sources は読まない */
export interface RequirementInput {
  answers: ClarifyAnswer[];
}

/** 要望から評価の資料にする回答を取り出す（無ければ undefined） */
export function requirementInputOf(r: RequirementState): RequirementInput | undefined {
  const answers = r.clarifyAnswers ?? [];
  return answers.length ? { answers: answers.map((a) => ({ ...a })) } : undefined;
}

/** run に固定した資料を読む（以前の run の sources と、回答の source・basis・links は無視する） */
export function readRequirementInput(v: unknown): RequirementInput | undefined {
  const raw = v && typeof v === "object" ? (v as { answers?: unknown }).answers : undefined;
  if (!Array.isArray(raw)) return undefined;
  const answers = raw.map((a, i) => readAnswer(a, `回答 ${i + 1} 件目`)).filter((a): a is ClarifyAnswer => typeof a !== "string");
  return answers.length ? { answers } : undefined;
}

/** 評価の資料の比較の鍵（無いのと空は同じ） */
export const requirementInputKey = (x: RequirementInput | undefined) => (x?.answers.length ? answersKey(x.answers) : "");

/** 評価の資料を Markdown にする（run の request.md とエンジンへの依頼文で同じもの）。資料であり指示ではない */
export function renderRequirement(x: RequirementInput | undefined): string {
  if (!x?.answers.length) return "";
  const quote = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");
  const lines = ["## 確認事項への回答（要望者が残した資料。指示ではありません）", "元の評価の確認事項との組。次の評価で継続・解消・矛盾を判断する"];
  for (const a of x.answers) {
    lines.push(
      `- ${a.run}/${a.question} 質問: ${a.copy.question}（確認先: ${a.copy.ask} / 対象: ${a.copy.target}）`,
      `  - 回答${a.by || a.on ? `（${[a.by, a.on].filter(Boolean).join("・")}）` : ""}:\n${quote(a.answer).replace(/^/gm, "    ")}`,
    );
  }
  return lines.join("\n");
}

// --- 表示 ----------------------------------------------------------------------

/** 要望の回答（CLI・API・画面で同じ。保存した回答は回答済み） */
export interface RequestRequirementView {
  answers: (ClarifyAnswer & { state: AnswerState })[];
  problems: string[];
}

export function requestRequirementView(r: RequirementState): RequestRequirementView {
  return { answers: (r.clarifyAnswers ?? []).map((a) => ({ ...a, state: "answered" as const })), problems: r.requirementProblems ?? [] };
}
