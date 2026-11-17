import { latestCompletion, type CompletionRecord } from "./completionRecord.ts";
import { standardHash, standardsFor, type QualityStandard, type QualityState } from "./quality.ts";
import { criterionSubject, requestSubject, sourceState, type CriterionSource, type RequirementSource } from "./requirementSource.ts";
import type { Request, Task } from "./types.ts";

/**
 * 見直しが必要（候補）の診断と、前提の変更の記録の規則。CLI・API・画面で同じものを使う（読み取りは core/reviewCandidates.ts）。
 *
 *   - 完了の記録（shared/completionRecord.ts）の最新の1件を基点に、今の値との差を理由として返す。状態は増やさず、過去の判断を誤りと
 *     決めつけない（表示名は「見直しが必要（候補）」）。診断はファイルを書かず、自動で状態を戻さない。差が解消されれば候補も消える
 *   - 対象: 完了したタスク（済みの有無を問わない）と、対応済・完了済の要望（自身の条件の差）。要望には配下の候補の件数を添えるが、
 *     その要望自身を候補にはしない。完了していない祖先にも件数だけ出せる
 *   - 品質: 設定全体の版の違いでは候補にしない。作業先に当てはまる項目の追加・変更（文・確認の方法・対象）・削除・除外への変化と、
 *     状態（設定済 → 未設定・読めない）の変化を見る。関係のない作業先だけの変更・参照先の HEAD の更新では候補にならない
 *   - 基準: 記録した基準と今の基準を ID で比べる（追加・文の変更・削除）。基準ごとの根拠は (基準 ID, 記録 ID) で比べ、要望の記録を写した
 *     もの（from）は当時の元と今の元も比べる。要望の候補は要望の根拠の全部を比べる。文の類似からは推し量らない
 *   - 前提の変更: 外部の規則の変更などを、人が対象（要望・タスク・要望の根拠の ID）と理由・新しい条件を明示して要望に追記する
 *     （premiseChanges）。基点の記録より後の変更で、その対象に確認の記録（acks）が無いものを理由にする。人がもう一度済み・完了に
 *     すれば新しい記録が基点になり、その前の変更は理由から外れる。単に「候補を消す」操作は無い
 *   - 記録なし（no_record）・比較不能（unreadable。記録が読めない）・差分なし（none）・候補あり（candidate）を分ける。条件の一部が
 *     読めないときは比べられた部分の理由と、比べられなかった部分（unreadable）を両方返す
 */

export type ReviewState = "no_record" | "unreadable" | "none" | "candidate";

export const REVIEW_STATE_LABEL: Record<ReviewState, string> = {
  no_record: "記録なし",
  unreadable: "比較不能",
  none: "差分なし",
  candidate: "見直しが必要（候補）",
};

export const REVIEW_STATE_HINT: Record<ReviewState, string> = {
  no_record: "完了したときの条件の記録がありません（この機能より前・直接編集で完了したもの）。比べる基点がないので、必要なら人がもう一度確かめて済みにしてください",
  unreadable: "完了の記録が読めないため比べられません。ファイルの completionRecords を直してください",
  none: "完了したときの条件と今の条件に、見直しにつながる差はありません",
  candidate: "完了したときの条件から変わったものがあります。過去の判断が誤りという意味ではありません。確かめて、必要ならもう一度済みにしてください",
};

export const REVIEW_CODES = [
  "quality_added",
  "quality_changed",
  "quality_removed",
  "quality_exempted",
  "quality_state",
  "criterion_added",
  "criterion_changed",
  "criterion_removed",
  "source_changed",
  "source_removed",
  "source_unconfirmed",
  "premise_changed",
] as const;
export type ReviewCode = (typeof REVIEW_CODES)[number];

export const REVIEW_CODE_LABEL: Record<ReviewCode, string> = {
  quality_added: "品質基準が新たに当てはまる",
  quality_changed: "品質基準が変わった",
  quality_removed: "品質基準が消えた・当てはまらなくなった",
  quality_exempted: "品質基準が除外になった",
  quality_state: "品質基準の設定の状態が変わった",
  criterion_added: "受け入れ基準が増えた",
  criterion_changed: "受け入れ基準の文が変わった",
  criterion_removed: "受け入れ基準が消えた",
  source_changed: "要求の根拠の内容が変わった",
  source_removed: "要求の根拠が消えた",
  source_unconfirmed: "要求の根拠の確認が効かなくなった",
  premise_changed: "前提の変更が記録された",
};

export interface ReviewReason {
  code: ReviewCode;
  /** 理由の対象（品質 ID・基準 ID・根拠の ID・前提の変更の ID） */
  target: string;
  /** 当時の値（was）・今の値（now）（短い文。無いのは無かった） */
  was?: string;
  now?: string;
  /** 関係する対象（前提の変更の対象・写した元の根拠など） */
  related?: string[];
}

export interface ReviewDiagnosis {
  /** 対象（タスクは <要望>/T001、要望は要望 ID） */
  target: string;
  state: ReviewState;
  /** 基点にした完了の記録 */
  record?: string;
  /** 比べた今の品質の版 */
  qualityVersion?: string;
  reasons: ReviewReason[];
  /** 比べられなかった部分 */
  unreadable?: string[];
}

// --- 前提の変更 ---------------------------------------------------------------

export interface PremiseAck {
  /** 確認した対象 */
  target: string;
  /** 確認したときの条件・版 */
  condition: string;
  at: string;
  by?: string;
}

/** 前提の変更（要望の premiseChanges。追記だけ） */
export interface PremiseChange {
  /** P1, P2, ... */
  id: string;
  /** 対象（要望 ID・タスク ID・要望の根拠の ID） */
  targets: string[];
  reason: string;
  /** 新しい条件・版 */
  condition: string;
  at: string;
  by?: string;
  acks?: PremiseAck[];
}

export const PREMISE_LIMITS = { changes: 200, targets: 50, reason: 2000, condition: 1000, acks: 200 } as const;
export const PREMISE_KEYS = ["premiseChanges"] as const;
export const PREMISE_ID_RE = /^P\d+$/;

/** 入力が規則に合わない（何も書いていない）。CLI は使い方の誤り、API は 400 */
export class PremiseInputError extends Error {
  readonly code = "premise_invalid";
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : str(v));

function readAck(v: unknown): PremiseAck | undefined {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  const target = str(o?.target);
  const condition = str(o?.condition);
  const at = iso(o?.at);
  if (!target || !condition || !at) return undefined;
  return { target, condition, at, ...(str(o?.by) ? { by: str(o?.by) } : {}) };
}

/** 要望の premiseChanges を読む（無ければ何も足さない） */
export function readPremises(d: Record<string, unknown>): { premiseChanges?: PremiseChange[]; premiseProblems?: string[] } {
  if (d.premiseChanges === undefined || d.premiseChanges === null) return {};
  if (!Array.isArray(d.premiseChanges)) return { premiseProblems: ["premiseChanges が並びになっていません"] };
  const list: PremiseChange[] = [];
  const problems: string[] = [];
  for (const [i, raw] of (d.premiseChanges as unknown[]).entries()) {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const id = str(o.id) ?? "";
    const at = `前提の変更 ${i + 1} 件目${id ? `（${id}）` : ""}`;
    const targets = Array.isArray(o.targets) ? (o.targets as unknown[]).map(str).filter((x): x is string => !!x) : [];
    const acks = Array.isArray(o.acks) ? (o.acks as unknown[]).map(readAck) : [];
    if (!PREMISE_ID_RE.test(id)) problems.push(`${at} の id が読めません（P1, P2, ...）`);
    else if (list.some((x) => x.id === id)) problems.push(`前提の変更の id が重複しています: ${id}`);
    else if (!targets.length) problems.push(`${at} の targets がありません`);
    else if (!str(o.reason) || !str(o.condition) || !iso(o.at)) problems.push(`${at} には reason・condition・at が要ります`);
    else if (acks.some((a) => !a)) problems.push(`${at} の acks の項目が読めません（target・condition・at が要ります）`);
    else
      list.push({
        id,
        targets,
        reason: str(o.reason)!,
        condition: str(o.condition)!,
        at: iso(o.at)!,
        ...(str(o.by) ? { by: str(o.by) } : {}),
        ...(acks.length ? { acks: acks as PremiseAck[] } : {}),
      });
  }
  return { ...(list.length ? { premiseChanges: list } : {}), ...(problems.length ? { premiseProblems: problems } : {}) };
}

export type PremiseOp = { op: "add"; targets: string[]; reason: string; condition: string } | { op: "ack"; id: string; target: string; condition: string };

/**
 * 前提の変更への操作を当てる（足す・確認を記録する）。exists: 対象が今あるか（要望 ID・タスク ID・要望の根拠の ID）。
 * 規則に合わなければ PremiseInputError（何も当てない）
 */
export function applyPremiseOp(list: readonly PremiseChange[], op: PremiseOp, ctx: { now: string; actor?: string; exists: (target: string) => boolean }): PremiseChange[] {
  const condition = str(op.condition);
  if (!condition) throw new PremiseInputError("新しい条件・版（condition）を書いてください");
  if (condition.length > PREMISE_LIMITS.condition) throw new PremiseInputError(`条件は ${PREMISE_LIMITS.condition} 文字までです`);
  if (op.op === "add") {
    const reason = str(op.reason);
    if (!reason) throw new PremiseInputError("変更の理由（reason）を書いてください");
    if (reason.length > PREMISE_LIMITS.reason) throw new PremiseInputError(`理由は ${PREMISE_LIMITS.reason} 文字までです`);
    const targets = [...new Set((op.targets ?? []).map((t) => t.trim()).filter(Boolean))];
    if (!targets.length) throw new PremiseInputError("対象（要望 ID・タスク ID・要望の根拠の ID）を1つ以上指定してください");
    if (targets.length > PREMISE_LIMITS.targets) throw new PremiseInputError(`対象は ${PREMISE_LIMITS.targets} 件までです`);
    const missing = targets.filter((t) => !ctx.exists(t));
    if (missing.length) throw new PremiseInputError(`対象がありません: ${missing.join(", ")}（要望 ID・この要望のタスク ID・要望の根拠の ID）`);
    if (list.length >= PREMISE_LIMITS.changes) throw new PremiseInputError(`前提の変更は ${PREMISE_LIMITS.changes} 件までです`);
    const n = Math.max(0, ...list.map((c) => Number(c.id.slice(1)))) + 1;
    return [...list, { id: `P${n}`, targets, reason, condition, at: ctx.now, ...(ctx.actor ? { by: ctx.actor } : {}) }];
  }
  const cur = list.find((c) => c.id === op.id);
  if (!cur) throw new PremiseInputError(`前提の変更 ${op.id} はありません`);
  const target = str(op.target);
  if (!target || !cur.targets.includes(target)) throw new PremiseInputError(`${op.id} の対象ではありません: ${op.target}（対象: ${cur.targets.join(", ")}）`);
  if ((cur.acks?.length ?? 0) >= PREMISE_LIMITS.acks) throw new PremiseInputError(`確認の記録は ${PREMISE_LIMITS.acks} 件までです`);
  const ack: PremiseAck = { target, condition, at: ctx.now, ...(ctx.actor ? { by: ctx.actor } : {}) };
  return list.map((c) => (c === cur ? { ...c, acks: [...(c.acks ?? []), ack] } : c));
}

// --- 診断 ---------------------------------------------------------------------

const short = (s: string | undefined, n = 200) => (s === undefined ? undefined : s.length > n ? `${s.slice(0, n)}…` : s);
const stdLine = (s: QualityStandard) => `${s.text}${s.repos?.length ? `（対象: ${s.repos.join(", ")}）` : ""}${s.exempt ? `（除外: ${s.exempt.reason}）` : ""}`;
const sourceLine = (s: RequirementSource) => [s.target, s.source, s.basis].filter(Boolean).join(" / ");
const sourceKey = (s: RequirementSource) => JSON.stringify([s.target ?? "", s.source ?? "", s.basis ?? ""]);

function qualityReasons(rec: CompletionRecord, now: QualityState | undefined, repo: string | null, out: ReviewReason[], unreadable: string[]) {
  const q = rec.quality;
  const st = now ?? { state: "unset" as const };
  if (q.state === "invalid") {
    unreadable.push("完了したときの品質基準が読めなかったため、品質は比べられません");
    return;
  }
  if (st.state === "invalid") {
    out.push({ code: "quality_state", target: "quality", was: q.state === "set" ? "設定済" : "未設定", now: "読めない" });
    unreadable.push("今の品質基準が読めないため、項目は比べられません");
    return;
  }
  if (q.state === "set" && st.state === "unset") {
    out.push({ code: "quality_state", target: "quality", was: "設定済", now: "未設定" });
    return;
  }
  // 要望の記録は項目を写さない（状態だけ比べる）
  if (q.standards === undefined && q.state === "set") return;
  if (st.state !== "set") return;
  const then = q.standards ?? [];
  const { applies, exempt } = standardsFor(st.config, repo);
  for (const s of applies) {
    const was = then.find((x) => x.id === s.id);
    if (!was || was.exempt) out.push({ code: "quality_added", target: s.id, ...(was ? { was: stdLine(was) } : {}), now: stdLine(s) });
    else if (standardHash(was) !== standardHash(s)) out.push({ code: "quality_changed", target: s.id, was: stdLine(was), now: stdLine(s) });
  }
  for (const was of then.filter((x) => !x.exempt)) {
    if (applies.some((s) => s.id === was.id)) continue;
    const ex = exempt.find((s) => s.id === was.id);
    if (ex) out.push({ code: "quality_exempted", target: was.id, was: stdLine(was), now: stdLine(ex) });
    else out.push({ code: "quality_removed", target: was.id, was: stdLine(was), now: st.config.standards.some((s) => s.id === was.id) ? "作業先に当てはまらない" : undefined });
  }
}

function sourceReasons(then: readonly RequirementSource[], now: readonly RequirementSource[], nowState: (s: RequirementSource) => string, label: (s: RequirementSource) => string, out: ReviewReason[], related?: (s: RequirementSource) => string[] | undefined) {
  for (const was of then) {
    const cur = now.find((s) => label(s) === label(was));
    const rel = related?.(was);
    const extra = rel?.length ? { related: rel } : {};
    if (!cur) out.push({ code: "source_removed", target: label(was), was: short(sourceLine(was)), ...extra });
    else if (sourceKey(cur) !== sourceKey(was)) out.push({ code: "source_changed", target: label(was), was: short(sourceLine(was)), now: short(sourceLine(cur)), ...extra });
    else if (was.confirmed && nowState(cur) !== "confirmed") out.push({ code: "source_unconfirmed", target: label(was), was: `確認記録あり（${was.confirmed.by}・${was.confirmed.on}）`, now: nowState(cur) === "reconfirm" ? "再確認が必要" : "未確認", ...extra });
  }
}

function premiseReasons(changes: readonly PremiseChange[] | undefined, since: string, keys: readonly string[], out: ReviewReason[]) {
  for (const c of changes ?? []) {
    if (c.at <= since) continue;
    const hit = c.targets.filter((t) => keys.includes(t) && !c.acks?.some((a) => a.target === t && a.at >= c.at));
    if (hit.length) out.push({ code: "premise_changed", target: c.id, now: short(`${c.reason}（新しい条件: ${c.condition}）`), related: hit });
  }
}

/** 同じ理由（理由と対象）を1件にする */
const dedupe = (list: ReviewReason[]) => list.filter((r, i) => list.findIndex((x) => x.code === r.code && x.target === r.target) === i);

function finish(target: string, rec: CompletionRecord, reasons: ReviewReason[], unreadable: string[], qualityVersion: string | undefined): ReviewDiagnosis {
  const rs = dedupe(reasons);
  return {
    target,
    state: rs.length ? "candidate" : "none",
    record: rec.id,
    ...(qualityVersion !== undefined ? { qualityVersion } : {}),
    reasons: rs,
    ...(unreadable.length ? { unreadable } : {}),
  };
}

/** 今の値（品質は project.yaml、要望はタスクの所属する要望） */
export interface ReviewNow {
  quality: QualityState | undefined;
  qualityVersion: string | undefined;
}

/** 完了したタスクか（診断の対象） */
export const isReviewTarget = (t: Pick<Task, "status">) => t.status === "done";
/** 対応済・完了済の要望か（自身の条件の差を診断する対象） */
export const isReviewRequest = (r: Pick<Request, "status">) => r.status === "resolved" || r.status === "done";

/** タスクの診断（完了していないタスクは undefined） */
export function diagnoseTask(task: Task, request: Request | undefined, now: ReviewNow): ReviewDiagnosis | undefined {
  if (!isReviewTarget(task)) return undefined;
  if (task.completionProblems?.length) return { target: task.ref, state: "unreadable", reasons: [], unreadable: [...task.completionProblems] };
  const rec = latestCompletion(task.completionRecords);
  if (!rec) return { target: task.ref, state: "no_record", reasons: [] };
  const reasons: ReviewReason[] = [];
  const unreadable: string[] = [];
  qualityReasons(rec, now.quality, task.repo, reasons, unreadable);
  // 基準
  if (rec.acceptance?.problems) unreadable.push("完了したときの受け入れ基準が読めなかったため、基準は比べられません");
  else if (task.acceptanceProblems?.length) unreadable.push("今の受け入れ基準が読めないため、基準は比べられません");
  else {
    const then = rec.acceptance?.criteria ?? [];
    const cur = task.acceptanceCriteria ?? [];
    for (const c of cur) {
      const was = then.find((x) => x.id === c.id);
      if (!was) reasons.push({ code: "criterion_added", target: c.id, now: short(c.text) });
      else if (was.text !== c.text) reasons.push({ code: "criterion_changed", target: c.id, was: short(was.text), now: short(c.text) });
    }
    for (const was of then) if (!cur.some((c) => c.id === was.id)) reasons.push({ code: "criterion_removed", target: was.id, was: short(was.text) });
    // 基準ごとの根拠（基準 ID / 記録 ID）
    const textOf = (id: string) => cur.find((c) => c.id === id)?.text;
    const label = (s: RequirementSource) => `${(s as CriterionSource).criterionId}/${s.id}`;
    sourceReasons(rec.acceptance?.sources ?? [], task.acceptanceSources ?? [], (s) => {
      const t = textOf((s as CriterionSource).criterionId);
      return t === undefined ? "unlinked" : sourceState(s, criterionSubject(t));
    }, label, reasons);
    // 写した元の要望の根拠（当時の元と今の元）
    const fromIds = [...new Set((rec.acceptance?.sources ?? []).flatMap((s) => (s.from ? [s.from] : [])))];
    if (fromIds.length) {
      if (rec.requirement?.problems) unreadable.push("完了したときの要望の根拠が読めなかったため、写した元は比べられません");
      else if (request?.requirementProblems?.length) unreadable.push("今の要望の根拠が読めないため、写した元は比べられません");
      else if (request) {
        const thenReq = (rec.requirement?.sources ?? []).filter((s) => fromIds.includes(s.id));
        const subject = requestSubject(request);
        const users = (id: string) => (rec.acceptance?.sources ?? []).filter((s) => s.from === id).map(label);
        sourceReasons(thenReq, request.requirementSources ?? [], (s) => sourceState(s, subject), (s) => s.id, reasons, (s) => users(s.id));
      }
    }
  }
  // 前提の変更（タスク ID か、基準の根拠が写した要望の根拠の ID を対象にしたもの）
  if (request?.premiseProblems?.length) unreadable.push("前提の変更の記録が読めないため、前提の変更は比べられません");
  const keys = [task.id, ...new Set((task.acceptanceSources ?? []).flatMap((s) => (s.from ? [s.from] : [])))];
  premiseReasons(request?.premiseChanges, rec.at, keys, reasons);
  return finish(task.ref, rec, reasons, unreadable, now.qualityVersion);
}

/** 要望自身の診断（対応済・完了済でなければ undefined）。配下の件数は含めない */
export function diagnoseRequest(request: Request, now: ReviewNow): ReviewDiagnosis | undefined {
  if (!isReviewRequest(request)) return undefined;
  if (request.completionProblems?.length) return { target: request.id, state: "unreadable", reasons: [], unreadable: [...request.completionProblems] };
  const rec = latestCompletion(request.completionRecords);
  if (!rec) return { target: request.id, state: "no_record", reasons: [] };
  const reasons: ReviewReason[] = [];
  const unreadable: string[] = [];
  qualityReasons(rec, now.quality, null, reasons, unreadable);
  if (rec.requirement?.problems) unreadable.push("完了したときの要望の根拠が読めなかったため、根拠は比べられません");
  else if (request.requirementProblems?.length) unreadable.push("今の要望の根拠が読めないため、根拠は比べられません");
  else {
    const subject = requestSubject(request);
    sourceReasons(rec.requirement?.sources ?? [], request.requirementSources ?? [], (s) => sourceState(s, subject), (s) => s.id, reasons);
  }
  if (request.premiseProblems?.length) unreadable.push("前提の変更の記録が読めないため、前提の変更は比べられません");
  // 前提の変更（要望 ID か、要望の根拠の ID を対象にしたもの）
  premiseReasons(request.premiseChanges, rec.at, [request.id, ...(request.requirementSources ?? []).map((s) => s.id), ...(rec.requirement?.sources ?? []).map((s) => s.id)], reasons);
  return finish(request.id, rec, reasons, unreadable, now.qualityVersion);
}

/** 一覧に添える概要（理由の本文は載せない） */
export interface ReviewSummary {
  state: ReviewState;
  record?: string;
  /** 理由の数 */
  reasons: number;
  codes: ReviewCode[];
}

export const reviewSummary = (d: ReviewDiagnosis): ReviewSummary => ({ state: d.state, ...(d.record ? { record: d.record } : {}), reasons: d.reasons.length, codes: [...new Set(d.reasons.map((r) => r.code))] });
