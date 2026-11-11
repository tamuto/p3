import type { Task } from "./types.ts";

/**
 * タスクの受け入れ基準（acceptanceCriteria）と、作業した側が項目ごとに残す証拠（acceptanceEvidence）の規則。
 * CLI・API・画面で同じものを使う（保存は core/requestOps.ts の createTask / updateTask がこれで確かめる）。
 *
 *   - 基準は { id, text } の並び。id は追加のときに振り（A1, A2, ...）、並べ替え・文言の変更で振り直さず、消した id も使い直さない
 *     （acceptanceSeq に振った最後の番号を残す）
 *   - 証拠は基準の id ごとに1件（再記録は置き換え）。記録したときの基準の文言（criterionText）を写して持つ。後で基準の文言を
 *     変えたら、その証拠は「再確認が必要」（stale）として達成に数えない。基準を消しても証拠は「対応する基準のない証拠」（orphan）として残す
 *   - 結果は met（満たした）/ unmet（満たせなかった）/ unverified（確かめていない）。met は証拠の本文が要る
 *   - 証拠は作業した側の申告で、レビューの判定ではない。不足があっても完了・済みを拒まない（不足は読めるようにするだけ）
 *   - 直接編集で壊れた項目は黙って消さず、problems として知らせる。problems があるタスクの基準・証拠は操作で変えず、
 *     関係のない更新ではファイルの元の値をそのまま書き戻す（core/store/collection.ts の keepRaw）
 */

export const ACCEPTANCE_RESULTS = ["met", "unmet", "unverified"] as const;
export type AcceptanceResult = (typeof ACCEPTANCE_RESULTS)[number];
export const isAcceptanceResult = (v: unknown): v is AcceptanceResult => typeof v === "string" && (ACCEPTANCE_RESULTS as readonly string[]).includes(v);

export const ACCEPTANCE_RESULT_LABEL: Record<AcceptanceResult, string> = {
  met: "満たした",
  unmet: "満たせなかった",
  unverified: "未検証",
};

export const ACCEPTANCE_LIMITS = {
  /** 基準の件数 */
  criteria: 50,
  /** 基準1件の文字数 */
  text: 1000,
  /** 証拠1件の文字数 */
  evidence: 20000,
} as const;

/** 受け入れ基準の1項目 */
export interface AcceptanceCriterion {
  /** タスクの中で安定した ID（A1, A2, ...） */
  id: string;
  text: string;
}

/** 基準1項目への証拠（作業した側の申告） */
export interface AcceptanceEvidence {
  criterionId: string;
  /** 記録したときの基準の文言。今の文言と違えば再確認が必要 */
  criterionText: string;
  result: AcceptanceResult;
  /** 通したテスト・実行したコマンドと結果・画面の確認・成果物へのリンクなど（Markdown） */
  evidence: string;
  recordedAt: string;
  recordedBy?: string;
}

/** タスクの基準・証拠の持ち物（Task の一部） */
export type AcceptanceState = Pick<Task, "acceptanceCriteria" | "acceptanceEvidence" | "acceptanceSeq">;

/** ファイルに書く基準・証拠の項目（壊れていたら元の値のまま書き戻す） */
export const ACCEPTANCE_KEYS = ["acceptanceCriteria", "acceptanceEvidence", "acceptanceSeq"] as const;

/** 直接編集で書いたものも読めるよう、A<番号> 以外の英数字の id も受け付ける。新しく振るのは A<番号> だけ */
export const CRITERION_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;

/** 入力が規則に合わない（何も書いていない）。CLI は使い方の誤り、API は 400 */
export class AcceptanceInputError extends Error {
  readonly code = "acceptance_invalid";
}

// --- 読む ---------------------------------------------------------------------

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === "string" && v ? v : undefined);

/**
 * frontmatter の値を読む。読めない項目は除いて problems に理由を足す（ファイルは書き換えない）。
 * どちらの項目も無ければ何も足さない（基準のない古いタスクはそのまま）
 */
export function readAcceptance(d: Record<string, unknown>): AcceptanceState & { acceptanceProblems?: string[] } {
  const problems: string[] = [];
  const out: AcceptanceState & { acceptanceProblems?: string[] } = {};
  if (d.acceptanceCriteria !== undefined && d.acceptanceCriteria !== null) {
    const criteria: AcceptanceCriterion[] = [];
    if (!Array.isArray(d.acceptanceCriteria)) problems.push("acceptanceCriteria が並びになっていません");
    else
      for (const [i, raw] of (d.acceptanceCriteria as unknown[]).entries()) {
        const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const id = text(o.id)?.trim() ?? "";
        const t = text(o.text)?.trim() ?? "";
        const at = `受け入れ基準 ${i + 1} 件目${id ? `（${id}）` : ""}`;
        if (!CRITERION_ID_RE.test(id)) problems.push(`${at} の id が読めません`);
        else if (criteria.some((c) => c.id === id)) problems.push(`受け入れ基準の id が重複しています: ${id}`);
        else if (!t) problems.push(`${at} の文が空です`);
        else criteria.push({ id, text: t });
      }
    out.acceptanceCriteria = criteria;
  }
  if (d.acceptanceEvidence !== undefined && d.acceptanceEvidence !== null) {
    const evidence: AcceptanceEvidence[] = [];
    if (!Array.isArray(d.acceptanceEvidence)) problems.push("acceptanceEvidence が並びになっていません");
    else
      for (const [i, raw] of (d.acceptanceEvidence as unknown[]).entries()) {
        const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const id = text(o.criterionId)?.trim() ?? "";
        const at = `証拠 ${i + 1} 件目${id ? `（${id}）` : ""}`;
        const body = text(o.evidence) ?? "";
        if (!CRITERION_ID_RE.test(id)) problems.push(`${at} の criterionId が読めません`);
        else if (evidence.some((e) => e.criterionId === id)) problems.push(`${id} の証拠が重複しています`);
        else if (!isAcceptanceResult(o.result)) problems.push(`${at} の result が読めません（${ACCEPTANCE_RESULTS.join(" / ")}）`);
        else if (o.result === "met" && !body.trim()) problems.push(`${at} は met ですが証拠が空です`);
        else
          evidence.push({
            criterionId: id,
            criterionText: text(o.criterionText)?.trim() ?? "",
            result: o.result,
            evidence: body.trim(),
            recordedAt: iso(o.recordedAt) ?? new Date(0).toISOString(),
            ...(text(o.recordedBy) ? { recordedBy: text(o.recordedBy) } : {}),
          });
      }
    out.acceptanceEvidence = evidence;
  }
  if (d.acceptanceSeq !== undefined && d.acceptanceSeq !== null) {
    const n = Number(d.acceptanceSeq);
    if (Number.isInteger(n) && n >= 0) out.acceptanceSeq = n;
    else problems.push("acceptanceSeq が読めません");
  }
  if (problems.length) out.acceptanceProblems = problems;
  return out;
}

// --- 変える -------------------------------------------------------------------

/** 基準・証拠への操作。CLI と API は同じ操作を送る */
export type AcceptanceOp =
  | { op: "add"; text: string }
  | { op: "edit"; id: string; text: string }
  | { op: "remove"; id: string }
  | { op: "order"; ids: string[] }
  | { op: "record"; id: string; result: AcceptanceResult; evidence: string }
  | { op: "unrecord"; id: string };

function cleanText(raw: string, label: string): string {
  const t = raw.trim();
  if (!t) throw new AcceptanceInputError(`${label}の文が空です`);
  if (t.length > ACCEPTANCE_LIMITS.text) throw new AcceptanceInputError(`${label}は ${ACCEPTANCE_LIMITS.text} 文字までです（${t.length} 文字）`);
  return t;
}

/** 振った最後の番号（acceptanceSeq と、今ある A<番号> の大きい方。消した id を使い直さない） */
function lastSeq(s: AcceptanceState): number {
  const ids = [...(s.acceptanceCriteria ?? []).map((c) => c.id), ...(s.acceptanceEvidence ?? []).map((e) => e.criterionId)];
  return ids.reduce((n, id) => Math.max(n, /^A(\d+)$/.exec(id) ? Number(id.slice(1)) : 0), s.acceptanceSeq ?? 0);
}

/**
 * 操作を順に当てた後の基準・証拠（何も書かない。規則に合わなければ AcceptanceInputError で、1件も当てない）。
 * 同じ値の再記録は元の証拠（記録した日時も）をそのまま残す
 */
export function applyAcceptanceOps(state: AcceptanceState & { acceptanceProblems?: string[] }, ops: readonly AcceptanceOp[], at: { now: string; actor?: string }): AcceptanceState {
  if (state.acceptanceProblems?.length) {
    throw new AcceptanceInputError(`受け入れ基準・証拠のファイルの値が読めないため変えられません。ファイルを直してください: ${state.acceptanceProblems.join(" / ")}`);
  }
  let criteria = [...(state.acceptanceCriteria ?? [])];
  let evidence = [...(state.acceptanceEvidence ?? [])];
  let seq = lastSeq(state);
  const find = (id: string) => {
    const c = criteria.find((x) => x.id === id);
    if (!c) throw new AcceptanceInputError(`受け入れ基準 ${id} はありません${criteria.length ? `（${criteria.map((x) => x.id).join(", ")}）` : "（基準がありません）"}`);
    return c;
  };
  for (const op of ops) {
    switch (op.op) {
      case "add": {
        if (criteria.length >= ACCEPTANCE_LIMITS.criteria) throw new AcceptanceInputError(`受け入れ基準は ${ACCEPTANCE_LIMITS.criteria} 件までです`);
        seq += 1;
        criteria.push({ id: `A${seq}`, text: cleanText(op.text, "受け入れ基準") });
        break;
      }
      case "edit": {
        const c = find(op.id);
        const t = cleanText(op.text, `受け入れ基準 ${op.id} `);
        criteria = criteria.map((x) => (x.id === c.id ? { ...x, text: t } : x));
        break;
      }
      case "remove": {
        find(op.id);
        // 証拠は残す（対応する基準のない証拠として読める）
        criteria = criteria.filter((x) => x.id !== op.id);
        break;
      }
      case "order": {
        const now = criteria.map((x) => x.id);
        const same = op.ids.length === now.length && new Set(op.ids).size === op.ids.length && op.ids.every((id) => now.includes(id));
        if (!same) throw new AcceptanceInputError(`並べ替えは今の基準の id を全部、1回ずつ指定してください（今: ${now.join(", ") || "なし"}）`);
        criteria = op.ids.map((id) => criteria.find((x) => x.id === id)!);
        break;
      }
      case "record": {
        const c = find(op.id);
        if (!isAcceptanceResult(op.result)) throw new AcceptanceInputError(`結果は ${ACCEPTANCE_RESULTS.join(" / ")} のどれかです: ${String(op.result)}`);
        const body = (op.evidence ?? "").trim();
        if (op.result === "met" && !body) throw new AcceptanceInputError(`${op.id} を met にするには証拠を書いてください（通したテスト・コマンドと結果・画面の確認・リンクなど）`);
        if (body.length > ACCEPTANCE_LIMITS.evidence) throw new AcceptanceInputError(`${op.id} の証拠は ${ACCEPTANCE_LIMITS.evidence} 文字までです（${body.length} 文字）`);
        const prev = evidence.find((e) => e.criterionId === c.id);
        if (prev && prev.result === op.result && prev.evidence === body && prev.criterionText === c.text) break;
        const entry: AcceptanceEvidence = { criterionId: c.id, criterionText: c.text, result: op.result, evidence: body, recordedAt: at.now, ...(at.actor ? { recordedBy: at.actor } : {}) };
        evidence = prev ? evidence.map((e) => (e === prev ? entry : e)) : [...evidence, entry];
        break;
      }
      case "unrecord": {
        if (!evidence.some((e) => e.criterionId === op.id)) throw new AcceptanceInputError(`${op.id} の証拠はありません`);
        evidence = evidence.filter((e) => e.criterionId !== op.id);
        break;
      }
      default:
        throw new AcceptanceInputError(`知らない操作です: ${String((op as { op: unknown }).op)}`);
    }
  }
  return {
    acceptanceCriteria: criteria.length ? criteria : undefined,
    acceptanceEvidence: evidence.length ? evidence : undefined,
    acceptanceSeq: seq > 0 ? seq : undefined,
  };
}

/** 基準・証拠の中身が変わったか（並び・文言・結果・証拠。記録の日時と変更者・採番は見ない）。人の「済み」を外す判断に使う */
export function acceptanceChanged(a: AcceptanceState, b: AcceptanceState): boolean {
  const key = (s: AcceptanceState) =>
    JSON.stringify([
      (s.acceptanceCriteria ?? []).map((c) => [c.id, c.text]),
      (s.acceptanceEvidence ?? []).map((e) => [e.criterionId, e.criterionText, e.result, e.evidence]),
    ]);
  return key(a) !== key(b);
}

// --- 不足を読む ----------------------------------------------------------------

/** 基準1項目の今の状態。missing: 証拠なし / stale: 基準の文言が記録した後に変わった */
export type CriterionState = AcceptanceResult | "missing" | "stale";

export interface AcceptanceStatus {
  /** 基準の件数 */
  total: number;
  /** 有効な met（今の文言で記録したもの）の件数 */
  met: number;
  items: { id: string; text: string; state: CriterionState; evidence?: AcceptanceEvidence }[];
  /** 対応する基準のない証拠（基準を消した） */
  orphans: AcceptanceEvidence[];
  problems: string[];
  /** 不足（人が「済み」にする前に読むもの）。無ければ空 */
  shortfalls: string[];
}

/** 基準・証拠の状態。基準も証拠も問題も無いタスクは undefined（「受け入れ基準なし」） */
export function acceptanceStatus(t: AcceptanceState & { acceptanceProblems?: string[] }): AcceptanceStatus | undefined {
  const criteria = t.acceptanceCriteria ?? [];
  const evidence = t.acceptanceEvidence ?? [];
  const problems = t.acceptanceProblems ?? [];
  if (!criteria.length && !evidence.length && !problems.length) return undefined;
  const items = criteria.map((c) => {
    const e = evidence.find((x) => x.criterionId === c.id);
    const state: CriterionState = !e ? "missing" : e.criterionText !== c.text ? "stale" : e.result;
    return { id: c.id, text: c.text, state, ...(e ? { evidence: e } : {}) };
  });
  const orphans = evidence.filter((e) => !criteria.some((c) => c.id === e.criterionId));
  const ids = (s: CriterionState) => items.filter((i) => i.state === s).map((i) => i.id);
  const shortfalls = [
    ...(ids("missing").length ? [`証拠なし: ${ids("missing").join(", ")}`] : []),
    ...(ids("unmet").length ? [`満たせなかった: ${ids("unmet").join(", ")}`] : []),
    ...(ids("unverified").length ? [`未検証: ${ids("unverified").join(", ")}`] : []),
    ...(ids("stale").length ? [`基準を変えた後の再確認が必要: ${ids("stale").join(", ")}`] : []),
    ...(orphans.length ? [`対応する基準のない証拠: ${orphans.map((e) => e.criterionId).join(", ")}`] : []),
    ...problems.map((p) => `読めない: ${p}`),
  ];
  return { total: criteria.length, met: ids("met").length, items, orphans, problems, shortfalls };
}

// --- CLI の証拠の入力 -----------------------------------------------------------

/** `A1=met:本文` / `A1=unverified`（本文は省ける。met は本文が要る） */
export function parseEvidenceArg(arg: string): Extract<AcceptanceOp, { op: "record" }> {
  const m = /^([A-Za-z0-9._-]+)=([a-z]+)(?::([\s\S]*))?$/.exec(arg.trim());
  if (!m || !isAcceptanceResult(m[2])) throw new AcceptanceInputError(`証拠は <基準の ID>=<${ACCEPTANCE_RESULTS.join("|")}>[:本文] の形で指定してください: ${arg}`);
  return { op: "record", id: m[1], result: m[2], evidence: m[3] ?? "" };
}

/**
 * 証拠のファイル（Markdown）。見出し `## <基準の ID> <結果>` ごとに、次の見出しまでを証拠の本文として読む。
 * 最初の見出しの前に文があれば断る（取りこぼさない）
 */
export function parseEvidenceFile(src: string): Extract<AcceptanceOp, { op: "record" }>[] {
  const out: Extract<AcceptanceOp, { op: "record" }>[] = [];
  let cur: Extract<AcceptanceOp, { op: "record" }> | undefined;
  const lines: string[] = [];
  const flush = () => {
    if (cur) out.push({ ...cur, evidence: lines.join("\n").trim() });
    lines.length = 0;
  };
  for (const line of src.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^##\s+([A-Za-z0-9._-]+)\s*[:：]?\s*([a-z]+)\s*$/.exec(line);
    if (h) {
      if (!isAcceptanceResult(h[2])) throw new AcceptanceInputError(`証拠のファイルの見出しの結果は ${ACCEPTANCE_RESULTS.join(" / ")} のどれかです: ${line}`);
      flush();
      cur = { op: "record", id: h[1], result: h[2], evidence: "" };
      continue;
    }
    if (!cur && line.trim()) throw new AcceptanceInputError(`証拠のファイルは「## <基準の ID> <結果>」の見出しから始めてください: ${line}`);
    lines.push(line);
  }
  flush();
  if (!out.length) throw new AcceptanceInputError("証拠のファイルに「## <基準の ID> <結果>」の見出しがありません");
  const dup = out.map((e) => e.id).find((id, i, a) => a.indexOf(id) !== i);
  if (dup) throw new AcceptanceInputError(`証拠のファイルに ${dup} が2回あります`);
  return out;
}

// --- Preflight のタスク案の基準 ----------------------------------------------------

/**
 * タスク案の基準（drafts/D1.md の acceptanceCriteria）を読む。Codex・手元のエージェントが書いた文の並び（["…"]）も、
 * { id, text } の並びも受け付け、id の無い項目には A<番号> を振る。読めない項目は除いて problems に理由を足す（無いのは基準なし）
 */
export function readDraftCriteria(raw: unknown): { criteria?: AcceptanceCriterion[]; problems?: string[] } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw)) return { criteria: [], problems: ["acceptanceCriteria が並びになっていません（文の並びで書いてください）"] };
  const problems: string[] = [];
  const items: { id?: string; text: string }[] = [];
  for (const [i, x] of (raw as unknown[]).entries()) {
    const at = `受け入れ基準 ${i + 1} 件目`;
    const o = typeof x === "string" ? { text: x } : x && typeof x === "object" ? (x as Record<string, unknown>) : undefined;
    const t = o && (typeof o.text === "string" || typeof o.text === "number") ? String(o.text).trim() : "";
    const id = o && (typeof o.id === "string" || typeof o.id === "number") ? String(o.id).trim() : undefined;
    if (!o) problems.push(`${at} が文になっていません`);
    else if (!t) problems.push(`${at} が空です`);
    else if (t.length > ACCEPTANCE_LIMITS.text) problems.push(`${at} は ${ACCEPTANCE_LIMITS.text} 文字までです（${t.length} 文字）`);
    else if (id !== undefined && !CRITERION_ID_RE.test(id)) problems.push(`${at} の id が使えません: ${id}`);
    else if (id !== undefined && items.some((c) => c.id === id)) problems.push(`受け入れ基準の id が重複しています: ${id}`);
    else items.push({ ...(id !== undefined ? { id } : {}), text: t });
  }
  if (items.length > ACCEPTANCE_LIMITS.criteria) problems.push(`受け入れ基準は ${ACCEPTANCE_LIMITS.criteria} 件までです（${items.length} 件）`);
  return { criteria: withIds(items), ...(problems.length ? { problems } : {}) };
}

/** id の無い項目に、今ある A<番号> の次から振る */
function withIds(items: readonly { id?: string; text: string }[]): AcceptanceCriterion[] {
  let n = items.reduce((m, c) => Math.max(m, c.id && /^A(\d+)$/.exec(c.id) ? Number(c.id.slice(1)) : 0), 0);
  return items.map((c) => ({ id: c.id ?? `A${++n}`, text: c.text }));
}

/**
 * 人が直したタスク案の基準（並び全体の置き換え）を確かめて保存する形にする。id は残し、無い項目に振る。
 * 空・長すぎる・件数・重複した id は AcceptanceInputError（何も書かない）
 */
export function tidyDraftCriteria(items: readonly { id?: string | null; text: string }[]): AcceptanceCriterion[] {
  if (items.length > ACCEPTANCE_LIMITS.criteria) throw new AcceptanceInputError(`受け入れ基準は ${ACCEPTANCE_LIMITS.criteria} 件までです（${items.length} 件）`);
  const seen = new Set<string>();
  const out = items.map((c, i) => {
    const id = c.id?.trim() || undefined;
    if (id !== undefined && !CRITERION_ID_RE.test(id)) throw new AcceptanceInputError(`受け入れ基準 ${i + 1} 件目の id が使えません: ${id}`);
    if (id !== undefined && seen.has(id)) throw new AcceptanceInputError(`受け入れ基準の id が重複しています: ${id}`);
    if (id !== undefined) seen.add(id);
    return { ...(id !== undefined ? { id } : {}), text: cleanText(c.text, `受け入れ基準 ${i + 1} 件目`) };
  });
  return withIds(out);
}

/** 基準の並びが同じか（id と文。タスク案の編集の競合を見る） */
export const sameCriteria = (a: readonly AcceptanceCriterion[] | undefined, b: readonly AcceptanceCriterion[] | undefined): boolean =>
  JSON.stringify((a ?? []).map((c) => [c.id, c.text])) === JSON.stringify((b ?? []).map((c) => [c.id, c.text]));

/** タスク案の基準からタスクの基準を作る（案の ID を残し、振った最後の番号を引き継ぐ） */
export function criteriaForTask(criteria: readonly AcceptanceCriterion[] | undefined): AcceptanceState {
  if (!criteria?.length) return {};
  return { acceptanceCriteria: criteria.map((c) => ({ ...c })), acceptanceSeq: lastSeq({ acceptanceCriteria: [...criteria] }) || undefined };
}
