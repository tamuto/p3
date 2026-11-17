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
 *   - 根拠の種類（basis）は結果と別に持つ: 未確認 / 申告のみ / 読んで確認（参照先）/ 検査結果あり（コマンド・結果・対象）。
 *     どれも作業した側の申告で、P3 は検査を実行しない。読んで確認と検査結果ありは方法の違いで、正しさの上下は付けない。
 *     人の「済み」はタスクごとの確認（checkedAt）で、根拠の種類には入れない。根拠の無い古い証拠は書き換えず、読むときだけ
 *     unverified は未確認、ほかは「申告のみ（種類未記録）」として扱う（本文から推し量って格上げしない）
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

/** 証拠の根拠の種類 */
export const EVIDENCE_BASIS_KINDS = ["unverified", "declaration", "read", "machine"] as const;
export type EvidenceBasisKind = (typeof EVIDENCE_BASIS_KINDS)[number];
export const isEvidenceBasisKind = (v: unknown): v is EvidenceBasisKind => typeof v === "string" && (EVIDENCE_BASIS_KINDS as readonly string[]).includes(v);

/**
 * 証拠の根拠（作業した側の申告）。read の reference は読んだコード・資料・画面と確かめた内容。machine の target は参照先とコミット
 * （未コミットならそう書く）、result は成功・失敗のどちらも記録できる（machine だから met とはしない）
 */
export type EvidenceBasis =
  | { kind: "unverified" }
  | { kind: "declaration" }
  | { kind: "read"; reference: string }
  | { kind: "machine"; command: string; result: string; target: string };

export const EVIDENCE_BASIS_LABEL: Record<EvidenceBasisKind, string> = {
  unverified: "未確認",
  declaration: "申告のみ",
  read: "読んで確認",
  machine: "検査結果あり",
};

/** 根拠の説明（画面の凡例・CLI の案内で使う） */
export const EVIDENCE_BASIS_HINT: Record<EvidenceBasisKind, string> = {
  unverified: "まだ確かめていない",
  declaration: "満たしたと作業した側が申告しただけ（確かめた方法の記録なし）",
  read: "作業した側（AI を含む）がコード・資料・画面を読んで確かめた",
  machine: "作業した側が記録した検査の結果（P3 は実行していない）",
};

export const BASIS_LIMITS = { reference: 1000, command: 1000, result: 2000, target: 300 } as const;

/** 受け入れ基準の1項目 */
export interface AcceptanceCriterion {
  /** タスクの中で安定した ID（A1, A2, ...） */
  id: string;
  text: string;
  /** プロジェクトの品質基準から取り込んだ出典（品質 ID・取り込んだときの項目の hash・設定の版。shared/quality.ts） */
  quality?: { id: string; hash: string; version: string };
}

/** 基準1項目への証拠（作業した側の申告） */
export interface AcceptanceEvidence {
  criterionId: string;
  /** 記録したときの基準の文言。今の文言と違えば再確認が必要 */
  criterionText: string;
  result: AcceptanceResult;
  /** 通したテスト・実行したコマンドと結果・画面の確認・成果物へのリンクなど（Markdown） */
  evidence: string;
  /** 根拠の種類。無いのは根拠を記録する前の古い証拠（読むときだけ evidenceBasisOf で解釈する） */
  basis?: EvidenceBasis;
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
        else if (o.quality !== undefined && !qualitySourceOf(o.quality)) problems.push(`${at} の品質基準の出典（quality）が読めません（id・hash・version が要ります）`);
        else criteria.push({ id, text: t, ...(o.quality !== undefined ? { quality: qualitySourceOf(o.quality)! } : {}) });
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
        else {
          const basis = o.basis === undefined || o.basis === null ? undefined : readBasis(o.basis);
          if (typeof basis === "string") problems.push(`${at} の根拠（basis）が読めません: ${basis}`);
          else if (basis && basisMismatch(o.result, basis)) problems.push(`${at} の根拠（basis）が結果と合いません: ${basisMismatch(o.result, basis)}`);
          else
            evidence.push({
              criterionId: id,
              criterionText: text(o.criterionText)?.trim() ?? "",
              result: o.result,
              evidence: body.trim(),
              ...(basis ? { basis } : {}),
              recordedAt: iso(o.recordedAt) ?? new Date(0).toISOString(),
              ...(text(o.recordedBy) ? { recordedBy: text(o.recordedBy) } : {}),
            });
        }
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

/** ファイルの根拠を読む（読めなければ理由の文） */
function readBasis(v: unknown): EvidenceBasis | string {
  try {
    return cleanBasis(v);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * 入力の根拠を確かめて保存する形にする（前後の空白を除く）。知らない種類・要る項目の欠け・長すぎるは AcceptanceInputError
 */
export function cleanBasis(v: unknown): EvidenceBasis {
  if (!v || typeof v !== "object") throw new AcceptanceInputError("根拠は { kind, ... } の形で指定してください");
  const o = v as Record<string, unknown>;
  if (!isEvidenceBasisKind(o.kind)) throw new AcceptanceInputError(`根拠の種類は ${EVIDENCE_BASIS_KINDS.join(" / ")} のどれかです: ${String(o.kind)}`);
  const field = (key: keyof typeof BASIS_LIMITS, label: string) => {
    const t = (text(o[key]) ?? "").trim();
    if (!t) throw new AcceptanceInputError(`根拠「${EVIDENCE_BASIS_LABEL[o.kind as EvidenceBasisKind]}」には${label}（${key}）が要ります`);
    if (t.length > BASIS_LIMITS[key]) throw new AcceptanceInputError(`根拠の${label}（${key}）は ${BASIS_LIMITS[key]} 文字までです（${t.length} 文字）`);
    return t;
  };
  switch (o.kind) {
    case "unverified":
    case "declaration":
      return { kind: o.kind };
    case "read":
      return { kind: "read", reference: field("reference", "読んだもの") };
    case "machine":
      return { kind: "machine", command: field("command", "検査のコマンド"), result: field("result", "検査の結果"), target: field("target", "対象（参照先とコミット）") };
  }
}

/** 結果と根拠の組み合わせが合わなければ理由。met / unmet に未確認は付けない、unverified は未確認だけ */
export function basisMismatch(result: AcceptanceResult, basis: EvidenceBasis): string | undefined {
  if (result === "unverified" && basis.kind !== "unverified") return `unverified（未検証）の根拠は「未確認」だけです（${EVIDENCE_BASIS_LABEL[basis.kind]} は付けられません）`;
  if (result !== "unverified" && basis.kind === "unverified") return `${result}（${ACCEPTANCE_RESULT_LABEL[result]}）に根拠「未確認」は付けられません（確かめていないなら結果を unverified にします）`;
  return undefined;
}

/** 根拠を省いた新しい入力の既定（unverified は未確認、ほかは申告のみ） */
export const defaultBasis = (result: AcceptanceResult): EvidenceBasis => (result === "unverified" ? { kind: "unverified" } : { kind: "declaration" });

/** 読むときの根拠。古い証拠（basis なし）は recorded: false で、unverified は未確認・ほかは申告のみと解釈する */
export function evidenceBasisOf(e: Pick<AcceptanceEvidence, "result" | "basis">): { basis: EvidenceBasis; recorded: boolean } {
  return e.basis ? { basis: e.basis, recorded: true } : { basis: defaultBasis(e.result), recorded: false };
}

/** 根拠の短い表示（例: 「検査結果あり」「申告のみ（種類未記録）」） */
export function basisLabel(e: Pick<AcceptanceEvidence, "result" | "basis">): string {
  const { basis, recorded } = evidenceBasisOf(e);
  return `${EVIDENCE_BASIS_LABEL[basis.kind]}${recorded ? "" : "（種類未記録）"}`;
}

/** 根拠の詳しい行（参照先・コマンド・結果・対象。CLI の show と画面で同じ並び） */
export function basisDetail(basis: EvidenceBasis): { label: string; value: string }[] {
  switch (basis.kind) {
    case "read":
      return [{ label: "読んだもの", value: basis.reference }];
    case "machine":
      return [
        { label: "コマンド", value: basis.command },
        { label: "検査の結果", value: basis.result },
        { label: "対象", value: basis.target },
      ];
    default:
      return [];
  }
}

function qualitySourceOf(v: unknown): AcceptanceCriterion["quality"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.hash === "string" && typeof o.version === "string" && o.id && o.hash ? { id: o.id, hash: o.hash, version: o.version } : undefined;
}

// --- 変える -------------------------------------------------------------------

/** 基準・証拠への操作。CLI と API は同じ操作を送る */
export type AcceptanceOp =
  | { op: "add"; text: string; quality?: AcceptanceCriterion["quality"] }
  | { op: "edit"; id: string; text: string; quality?: AcceptanceCriterion["quality"] }
  | { op: "remove"; id: string }
  | { op: "order"; ids: string[] }
  /** basis を省くと、同じ結果の前の証拠があればその根拠を引き継ぎ、無ければ既定（unverified は未確認、ほかは申告のみ） */
  | { op: "record"; id: string; result: AcceptanceResult; evidence: string; basis?: EvidenceBasis }
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
        if (op.quality && criteria.some((c) => c.quality?.id === op.quality!.id)) throw new AcceptanceInputError(`品質基準 ${op.quality.id} は取り込み済みです`);
        seq += 1;
        criteria.push({ id: `A${seq}`, text: cleanText(op.text, "受け入れ基準"), ...(op.quality ? { quality: { ...op.quality } } : {}) });
        break;
      }
      case "edit": {
        const c = find(op.id);
        const t = cleanText(op.text, `受け入れ基準 ${op.id} `);
        criteria = criteria.map((x) => (x.id === c.id ? { ...x, text: t, ...(op.quality ? { quality: { ...op.quality } } : {}) } : x));
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
        // 根拠を省いた入力（古い CLI・画面）は、同じ結果の前の証拠の根拠をそのまま使う（無ければ既定）。古い証拠を開いて同じ値で
        // 保存し直しても、根拠を足したことにはならない
        const basis = op.basis !== undefined ? cleanBasis(op.basis) : prev && prev.result === op.result ? prev.basis : defaultBasis(op.result);
        const mismatch = basis && basisMismatch(op.result, basis);
        if (mismatch) throw new AcceptanceInputError(`${op.id}: ${mismatch}`);
        if (prev && prev.result === op.result && prev.evidence === body && prev.criterionText === c.text && sameBasis(prev.basis, basis)) break;
        const entry: AcceptanceEvidence = {
          criterionId: c.id,
          criterionText: c.text,
          result: op.result,
          evidence: body,
          ...(basis ? { basis } : {}),
          recordedAt: at.now,
          ...(at.actor ? { recordedBy: at.actor } : {}),
        };
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

/** 保存した根拠の比較の鍵（項目の順によらない） */
const basisKey = (b: EvidenceBasis | undefined) => (b ? JSON.stringify(Object.entries(b).sort(([x], [y]) => x.localeCompare(y))) : "");
const sameBasis = (a: EvidenceBasis | undefined, b: EvidenceBasis | undefined) => basisKey(a) === basisKey(b);

/** 基準・証拠の中身が変わったか（並び・文言・結果・証拠・根拠。記録の日時と変更者・採番は見ない）。人の「済み」を外す判断に使う */
export function acceptanceChanged(a: AcceptanceState, b: AcceptanceState): boolean {
  const key = (s: AcceptanceState) =>
    JSON.stringify([
      (s.acceptanceCriteria ?? []).map((c) => [c.id, c.text]),
      (s.acceptanceEvidence ?? []).map((e) => [e.criterionId, e.criterionText, e.result, e.evidence, basisKey(e.basis)]),
    ]);
  return key(a) !== key(b);
}

// --- 不足を読む ----------------------------------------------------------------

/** 基準1項目の今の状態。missing: 証拠なし / stale: 基準の文言が記録した後に変わった */
export type CriterionState = AcceptanceResult | "missing" | "stale";

export interface AcceptanceStatus {
  /** 基準の件数 */
  total: number;
  /** 有効な met（今の文言で記録したもの）の件数。満たしたと申告した数で、確かめた数ではない（根拠は metByBasis） */
  met: number;
  /** 有効な met の根拠ごとの件数（古い証拠は申告のみに数える。stale・orphan は入れない） */
  metByBasis: Record<EvidenceBasisKind, number>;
  /** 有効な met のうち根拠が申告のみの基準の ID（古い証拠を含む） */
  declarationOnly: string[];
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
  const metByBasis = Object.fromEntries(EVIDENCE_BASIS_KINDS.map((k) => [k, 0])) as Record<EvidenceBasisKind, number>;
  const declarationOnly: string[] = [];
  for (const i of items) {
    if (i.state !== "met" || !i.evidence) continue;
    const kind = evidenceBasisOf(i.evidence).basis.kind;
    metByBasis[kind] += 1;
    if (kind === "declaration") declarationOnly.push(i.id);
  }
  const shortfalls = [
    ...(ids("missing").length ? [`証拠なし: ${ids("missing").join(", ")}`] : []),
    ...(ids("unmet").length ? [`満たせなかった: ${ids("unmet").join(", ")}`] : []),
    ...(ids("unverified").length ? [`未検証: ${ids("unverified").join(", ")}`] : []),
    ...(ids("stale").length ? [`基準を変えた後の再確認が必要: ${ids("stale").join(", ")}`] : []),
    // 注意（完了・済みは拒まない）: 満たしたと申告しただけで、確かめた方法の記録が無い
    ...(declarationOnly.length ? [`申告のみの met（確かめた方法の記録なし）: ${declarationOnly.join(", ")}`] : []),
    ...(orphans.length ? [`対応する基準のない証拠: ${orphans.map((e) => e.criterionId).join(", ")}`] : []),
    ...problems.map((p) => `読めない: ${p}`),
  ];
  return { total: criteria.length, met: ids("met").length, metByBasis, declarationOnly, items, orphans, problems, shortfalls };
}

/** 進捗の一覧に載せる小さな概要（本文は載せない）。基準も証拠も問題も無いタスクは undefined */
export interface EvidenceSummary {
  /** 有効な met の件数（満たしたと申告した数） */
  met: number;
  total: number;
  /** 申告のみの met の件数 */
  declarationOnly: number;
  metByBasis: Record<EvidenceBasisKind, number>;
  /** 読めない値がある */
  problems: boolean;
}

export function evidenceSummary(t: AcceptanceState & { acceptanceProblems?: string[] }): EvidenceSummary | undefined {
  const s = acceptanceStatus(t);
  if (!s) return undefined;
  return { met: s.met, total: s.total, declarationOnly: s.declarationOnly.length, metByBasis: s.metByBasis, problems: s.problems.length > 0 };
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

/**
 * 証拠の JSON（構造化）。[{ id, result, evidence?, basis? }] の並びで、record と同じ規則で読む。
 * 例: [{"id":"A1","result":"met","evidence":"対象のテストが通った","basis":{"kind":"machine","command":"pnpm vitest run test/x.test.ts","result":"終了コード 0","target":"p3:abc1234"}}]
 */
export function parseEvidenceJson(src: string): Extract<AcceptanceOp, { op: "record" }>[] {
  let raw: unknown;
  try {
    raw = JSON.parse(src);
  } catch (e) {
    throw new AcceptanceInputError(`証拠の JSON が読めません: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(raw) || !raw.length) throw new AcceptanceInputError("証拠の JSON は [{ id, result, evidence?, basis? }] の並び（1件以上）にしてください");
  const out = (raw as unknown[]).map((x, i): Extract<AcceptanceOp, { op: "record" }> => {
    const at = `証拠の JSON の ${i + 1} 件目`;
    if (!x || typeof x !== "object" || Array.isArray(x)) throw new AcceptanceInputError(`${at} が { id, result, ... } になっていません`);
    const o = x as Record<string, unknown>;
    const unknownKeys = Object.keys(o).filter((k) => !["id", "result", "evidence", "basis"].includes(k));
    if (unknownKeys.length) throw new AcceptanceInputError(`${at} に知らない項目があります: ${unknownKeys.join(", ")}（id・result・evidence・basis）`);
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!CRITERION_ID_RE.test(id)) throw new AcceptanceInputError(`${at} の id が読めません`);
    if (!isAcceptanceResult(o.result)) throw new AcceptanceInputError(`${at}（${id}）の result は ${ACCEPTANCE_RESULTS.join(" / ")} のどれかです`);
    if (o.evidence !== undefined && typeof o.evidence !== "string") throw new AcceptanceInputError(`${at}（${id}）の evidence は文字列です`);
    return { op: "record", id, result: o.result, evidence: o.evidence ?? "", ...(o.basis !== undefined ? { basis: cleanBasis(o.basis) } : {}) };
  });
  const dup = out.map((e) => e.id).find((id, i, a) => a.indexOf(id) !== i);
  if (dup) throw new AcceptanceInputError(`証拠の JSON に ${dup} が2回あります`);
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

// --- 画面の基準の編集 ---------------------------------------------------------------

/**
 * 画面で並び全体を直した結果（rows。id の無い行は新しい基準）を、今の基準（state）への操作にする:
 * 消す → 文を変える → 足す → 並べる（足した基準の id は今の採番の続きになる。rev を添えて送れば、他で変わっていれば 409 で当たらない）。
 * 変わっていなければ空。id が今の基準に無い行は新しい基準として足す
 */
export function criteriaEditOps(state: AcceptanceState, rows: readonly { id?: string; text: string }[]): AcceptanceOp[] {
  const cur = state.acceptanceCriteria ?? [];
  const known = new Set(cur.map((c) => c.id));
  const kept = rows.filter((r) => r.id !== undefined && known.has(r.id));
  const keptIds = new Set(kept.map((r) => r.id!));
  const ops: AcceptanceOp[] = [];
  for (const c of cur) if (!keptIds.has(c.id)) ops.push({ op: "remove", id: c.id });
  for (const r of kept) if (cur.find((c) => c.id === r.id)!.text !== r.text.trim()) ops.push({ op: "edit", id: r.id!, text: r.text });
  let seq = lastSeq(state);
  const finalIds = rows.map((r) => (r.id !== undefined && keptIds.has(r.id) ? r.id : `A${++seq}`));
  for (const r of rows) if (!(r.id !== undefined && keptIds.has(r.id))) ops.push({ op: "add", text: r.text });
  const afterIds = [...cur.filter((c) => keptIds.has(c.id)).map((c) => c.id), ...finalIds.filter((id) => !keptIds.has(id))];
  if (afterIds.join(",") !== finalIds.join(",")) ops.push({ op: "order", ids: finalIds });
  return ops;
}
