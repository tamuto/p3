import type { PreflightRun, RequestStatus } from "../../../shared/types.ts";

/**
 * 要望の振り返り（Preflight で心配したリスクが実装の後に起きたか）の規則。CLI・API・画面で同じものを使う（保存は core/retrospective.ts）。
 *
 *   - 振り返りの対象は、要望につき1つの採用済みの Preflight の run で、人が確定する（最新の実行・採用・画面での閲覧の切り替えでは変わらない）
 *   - 候補: 評価が終わり（completed）、タスク化を終えた run（materialization.done。作ったタスクと照らす）と、子の要望の採用を終えた run
 *     （adoption.done。作った子の splitFrom と照らす。分割の採用として出す）。materialization の無い以前の run の materialized は「旧記録」と明記する。
 *     途中の採用・未完了の評価・評価の無い run・見送りの要望は候補にしない。直接作ったタスクだけの要望は候補なし
 *   - 確定するときに、run.json の評価の版（assessmentVersion。評価の内容の hash）と、リスクの位置と原文を写す。後で run が変わっても、
 *     写した原文で読む。訂正は追記で、理由と前の対象を残す。保存はファイルの版（version）で照らし、要望のロックの中で書く
 *   - 振り返りの記録は要望のフォルダの retrospective.json（要望と一緒にアーカイブ・共有する）
 */

/** 採用の種類。tasks: タスク化 / split: 子の要望への分割の採用 / legacy: 以前の記録（materialized だけ） */
export type AdoptionKind = "tasks" | "split" | "legacy";

export const ADOPTION_KIND_LABEL: Record<AdoptionKind, string> = {
  tasks: "タスク化",
  split: "分割の採用",
  legacy: "タスク化（旧記録）",
};

/** 採用の根拠の1件（作ったタスク・子の要望と、今あるか） */
export interface AdoptionBasis {
  /** 案のキー（D1・C1。旧記録は無い） */
  key?: string;
  /** 作ったタスクの ID（T001）か子の要望の ID */
  target: string;
  /** present: ある / archived: アーカイブ済み / missing: 見つからない / mismatch: 子の採用元（splitFrom）が合わない */
  state: "present" | "archived" | "missing" | "mismatch";
}

export interface RetroCandidate {
  run: string;
  kind: AdoptionKind;
  /** 採用した日時の目安（run の終わった日時） */
  finishedAt?: string;
  /** 一番新しい採用済みの run */
  latest: boolean;
  basis: AdoptionBasis[];
  /** リスクの数（評価の risks） */
  risks: number;
  verdict?: string;
}

/** 確定した振り返りの対象（追記だけ。最後が今の対象） */
export interface RetroTarget {
  /** V1, V2, ... */
  id: string;
  run: string;
  kind: AdoptionKind;
  /** 確定したときの評価の版（評価の内容の hash） */
  assessmentVersion: string;
  /** 確定したときのリスク（評価の risks の位置と原文） */
  risks: { index: number; text: string }[];
  /** 確定したときの採用の根拠 */
  basis: AdoptionBasis[];
  at: string;
  by?: string;
  /** 訂正の理由（2件目から） */
  reason?: string;
  /** 前の対象（訂正したとき） */
  replaces?: string;
}

// --- リスクの確認 ---------------------------------------------------------------

/** 確認の状態。occurred: 起きた / not_occurred: 起きなかった / unchecked: 確かめていない */
export const RISK_STATES = ["occurred", "not_occurred", "unchecked"] as const;
export type RiskState = (typeof RISK_STATES)[number];
export const isRiskState = (v: unknown): v is RiskState => typeof v === "string" && (RISK_STATES as readonly string[]).includes(v);

export const RISK_STATE_LABEL: Record<RiskState, string> = { occurred: "起きた", not_occurred: "起きなかった", unchecked: "未確認" };

/** タスクレビューの所見の場所（結果の項目と位置） */
export const TASK_REVIEW_SECTIONS = ["overall", "items", "quality", "unplanned", "checks"] as const;
export type TaskReviewSection = (typeof TASK_REVIEW_SECTIONS)[number];
/** マイルストーンレビューの所見の場所 */
export const MILESTONE_REVIEW_SECTIONS = ["overall", "units", "quality", "unplanned"] as const;
export type MilestoneReviewSection = (typeof MILESTONE_REVIEW_SECTIONS)[number];

/**
 * 確認の根拠（保存したときの参照先と抜粋を残す。後で所属・記録が変わっても、この参照と抜粋で読む）。
 *   task_review: 要望のタスクの AI レビューの所見（run と結果の版・位置）/ milestone_review: マイルストーンレビューの所見（固定した材料で
 *   この要望が直接の対象だったもの。全体の所見はこの要望と結び付く理由が要る）/ rework: タスクの手戻りの履歴 / manual: 人が書く参照（成果物・検証結果など）
 */
export type RetroEvidence =
  | { kind: "task_review"; request: string; task: string; run: string; section: TaskReviewSection; index: number; resultVersion: string; excerpt: string }
  | { kind: "milestone_review"; milestone: string; run: string; section: MilestoneReviewSection; index: number; resultVersion: string; excerpt: string; inputChanged?: boolean; reason?: string }
  | { kind: "rework"; request: string; task: string; history: string; excerpt: string }
  | { kind: "manual"; reference: string; note?: string };

export const RETRO_EVIDENCE_LABEL: Record<RetroEvidence["kind"], string> = {
  task_review: "タスクの AI レビュー",
  milestone_review: "マイルストーンレビュー",
  rework: "手戻り",
  manual: "人が書いた参照",
};

/** 根拠の今の照合（読むときに確かめる）。ok: 今も同じ / changed: 記録が差し替わった / missing: 今は見つからない / manual: 確かめない（人の参照） */
export type EvidenceCheck = "ok" | "changed" | "missing" | "manual";

export const EVIDENCE_CHECK_LABEL: Record<EvidenceCheck, string> = { ok: "照合済み", changed: "記録が差し替わった", missing: "今は見つからない", manual: "人の参照（照合しない）" };

/** リスクの確認1件（追記だけ。同じ対象とリスクの最後の1件が今の確認） */
export interface RiskJudgment {
  /** J1, J2, ... */
  id: string;
  /** 確定した対象（V1）とリスクの位置 */
  target: string;
  risk: number;
  /** 確認したときのリスクの原文 */
  riskText: string;
  state: RiskState;
  /** 確認した事実（起きたとき必須） */
  facts?: string;
  /** 確認した範囲（対象の成果・時点・範囲。起きなかったとき必須） */
  scope?: string;
  evidence: RetroEvidence[];
  /** 判断を変える・未確認に戻すときの理由 */
  reason?: string;
  at: string;
  by?: string;
}

/** 今の対象のリスクごとの確認（今の確認と、そのリスクの確認の履歴） */
export interface RetroRiskView {
  index: number;
  text: string;
  state: RiskState;
  judgment?: RiskJudgment;
  history: RiskJudgment[];
}

export interface RetrospectiveView {
  version: number;
  /** 今の対象のリスクと確認（対象が無ければ空） */
  risks: RetroRiskView[];
  /** 今の対象の三状態の件数（確認の無いリスクは未確認） */
  counts: Record<RiskState, number>;
  /** 全部の確認（前の対象の分も。古い順） */
  judgments: RiskJudgment[];
  /** 確認ごとの根拠の今の照合（確認 ID → 根拠の順） */
  checks: Record<string, EvidenceCheck[]>;
  /** 今の対象（無ければ未確定） */
  target?: RetroTarget;
  /** 確定と訂正の履歴（古い順） */
  targets: RetroTarget[];
  candidates: RetroCandidate[];
  /** 候補が無い理由 */
  none?: string;
}

/** 根拠の指定（CLI・API から。保存するときに今の記録と照らし、抜粋と版を写す） */
export type EvidenceRef =
  | { kind: "task_review"; task: string; run: string; section: TaskReviewSection; index?: number }
  | { kind: "milestone_review"; milestone: string; run: string; section: MilestoneReviewSection; index?: number; reason?: string }
  | { kind: "rework"; task: string; history: string }
  | { kind: "manual"; reference: string; note?: string };

export const JUDGMENT_LIMITS = { text: 4000, evidence: 30, excerpt: 1000 } as const;

/** retrospective.json の中身 */
export interface RetrospectiveFile {
  /** 保存するたびに 1 ずつ上がる版（無ければ 0） */
  version: number;
  targets: RetroTarget[];
  /** リスクの確認（追記だけ。無ければ空） */
  judgments?: RiskJudgment[];
}

/** 対象とリスクの今の確認（無ければ undefined = 未確認） */
export const latestJudgment = (f: RetrospectiveFile, target: string, risk: number): RiskJudgment | undefined =>
  [...(f.judgments ?? [])].reverse().find((j) => j.target === target && j.risk === risk);

/** 今の対象の三状態の件数（確認の無いリスクは未確認） */
export function riskCounts(f: RetrospectiveFile): Record<RiskState, number> {
  const counts: Record<RiskState, number> = { occurred: 0, not_occurred: 0, unchecked: 0 };
  const t = currentTarget(f);
  for (const r of t?.risks ?? []) counts[latestJudgment(f, t!.id, r.index)?.state ?? "unchecked"]++;
  return counts;
}

/**
 * リスクの確認を足す（足した値を返す）。対象は今の確定した対象だけ。起きた → 確認した事実と根拠、起きなかった → 確認した範囲と根拠が要る。
 * 根拠を結び付けるだけなら未確認のまま。決めた確認を変える・未確認に戻すには理由が要る。規則に合わなければ RetrospectiveError（何も当てない）
 */
export function addJudgment(
  file: RetrospectiveFile,
  input: { risk: number; state: RiskState; facts?: string; scope?: string; reason?: string; evidence: RetroEvidence[] },
  ctx: { now: string; actor?: string },
): RetrospectiveFile {
  const t = currentTarget(file);
  if (!t) throw new RetrospectiveError("retro_invalid", "振り返りの対象が確定していません（先に p3 retro confirm <run>）");
  const risk = t.risks.find((r) => r.index === input.risk);
  if (!risk) throw new RetrospectiveError("retro_invalid", `対象 ${t.id}（${t.run}）にリスク ${input.risk + 1} はありません（リスクは ${t.risks.length} 件）`);
  if (!isRiskState(input.state)) throw new RetrospectiveError("retro_invalid", `状態は ${RISK_STATES.join(" / ")} です`);
  const facts = input.facts?.trim() || undefined;
  const scope = input.scope?.trim() || undefined;
  const reason = input.reason?.trim() || undefined;
  for (const [k, v] of [["事実", facts], ["範囲", scope], ["理由", reason]] as const) if (v && v.length > JUDGMENT_LIMITS.text) throw new RetrospectiveError("retro_invalid", `${k}は ${JUDGMENT_LIMITS.text} 文字までです`);
  if (input.evidence.length > JUDGMENT_LIMITS.evidence) throw new RetrospectiveError("retro_invalid", `根拠は ${JUDGMENT_LIMITS.evidence} 件までです`);
  if (input.state === "occurred" && (!facts || !input.evidence.length)) throw new RetrospectiveError("retro_invalid", "「起きた」には確認した事実（facts）と根拠（evidence）が要ります");
  if (input.state === "not_occurred" && (!scope || !input.evidence.length)) throw new RetrospectiveError("retro_invalid", "「起きなかった」には確認した範囲（scope）と根拠（evidence）が要ります");
  const prev = latestJudgment(file, t.id, input.risk);
  if (prev && prev.state !== "unchecked" && !reason) throw new RetrospectiveError("retro_invalid", `リスク ${input.risk + 1} は「${RISK_STATE_LABEL[prev.state]}」と確認済みです。変える・未確認に戻すには理由（reason）を書いてください`);
  if (input.state === "unchecked" && !input.evidence.length && !prev) throw new RetrospectiveError("retro_invalid", "未確認のままにするなら、結び付ける根拠を1つ以上指定してください");
  const n = Math.max(0, ...(file.judgments ?? []).map((j) => Number(j.id.slice(1)))) + 1;
  const j: RiskJudgment = {
    id: `J${n}`,
    target: t.id,
    risk: input.risk,
    riskText: risk.text,
    state: input.state,
    ...(facts ? { facts } : {}),
    ...(scope ? { scope } : {}),
    evidence: input.evidence,
    ...(reason ? { reason } : {}),
    at: ctx.now,
    ...(ctx.actor ? { by: ctx.actor } : {}),
  };
  return { ...file, version: file.version + 1, judgments: [...(file.judgments ?? []), j] };
}

export class RetrospectiveError extends Error {
  constructor(
    readonly code: "retro_invalid" | "retro_conflict" | "retro_unreadable",
    message: string,
  ) {
    super(message);
  }
}

export const RETRO_LIMITS = { reason: 2000 } as const;

/** 評価の版（評価の内容の hash。依存を足さない） */
export function assessmentVersion(assessment: unknown): string {
  const s = JSON.stringify(assessment ?? null);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** 照らすための周り（タスクの有無と子の要望） */
export interface RetroLookup {
  task: (tid: string) => "present" | "archived" | "missing";
  child: (rid: string) => { splitFrom?: string; parent?: string } | undefined;
}

type RunLike = Pick<PreflightRun, "id" | "status" | "finishedAt" | "assessment" | "materialization" | "materialized" | "adoption">;

/** 1つの run の採用（候補にならなければ undefined） */
function adoptionOf(requestId: string, run: RunLike, lookup: RetroLookup): Omit<RetroCandidate, "latest"> | undefined {
  if (run.status !== "completed" || !run.assessment) return undefined;
  const base = { run: run.id, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}), risks: run.assessment.risks?.length ?? 0, verdict: run.assessment.verdict };
  if (run.materialization) {
    if (!run.materialization.done) return undefined;
    const basis = Object.entries(run.materialization.created).map(([key, tid]): AdoptionBasis => ({ key, target: tid, state: lookup.task(tid) }));
    return basis.length ? { ...base, kind: "tasks", basis } : undefined;
  }
  if (run.adoption) {
    if (!run.adoption.done) return undefined;
    const basis = run.adoption.created.map((key): AdoptionBasis => {
      const id = run.adoption!.reserved[key];
      const c = id ? lookup.child(id) : undefined;
      return { key, target: id ?? key, state: !c ? "missing" : c.splitFrom === `${run.id}/${key}` && c.parent === requestId ? "present" : "mismatch" };
    });
    return basis.length ? { ...base, kind: "split", basis } : undefined;
  }
  if (run.materialized?.length) return { ...base, kind: "legacy", basis: run.materialized.map((tid): AdoptionBasis => ({ target: tid, state: lookup.task(tid) })) };
  return undefined;
}

/**
 * 要望の候補（新しい順。runs は新しい順で渡す）。見送りの要望は候補なし（none に理由）。
 */
export function retroCandidates(requestId: string, status: RequestStatus, runs: readonly RunLike[], lookup: RetroLookup): { candidates: RetroCandidate[]; none?: string } {
  if (status === "rejected") return { candidates: [], none: "見送りの要望は振り返りの対象にしません" };
  const list = runs.flatMap((r) => {
    const a = adoptionOf(requestId, r, lookup);
    return a ? [a] : [];
  });
  if (!list.length) return { candidates: [], none: "採用を終えた Preflight がありません（直接作ったタスクだけ・採用の前・評価の途中など）" };
  return { candidates: list.map((c, i) => ({ ...c, latest: i === 0 })) };
}

/** 今の対象（無ければ undefined） */
export const currentTarget = (f: RetrospectiveFile): RetroTarget | undefined => f.targets.at(-1);

/**
 * 対象を確定する（足した値を返す）。run は候補の中の1つで、評価があること。2件目からは訂正の理由が要る。
 * 規則に合わなければ RetrospectiveError（何も当てない）
 */
export function confirmTarget(
  file: RetrospectiveFile,
  input: { run: string; reason?: string },
  ctx: { candidates: readonly RetroCandidate[]; none?: string; risksOf: (run: string) => string[] | undefined; assessmentOf: (run: string) => unknown; now: string; actor?: string },
): RetrospectiveFile {
  const cand = ctx.candidates.find((c) => c.run === input.run);
  if (!cand) throw new RetrospectiveError("retro_invalid", `${input.run} は振り返りの対象の候補ではありません（${ctx.none ?? `候補: ${ctx.candidates.map((c) => c.run).join(", ")}`}）`);
  const risks = ctx.risksOf(input.run);
  const assessment = ctx.assessmentOf(input.run);
  if (!risks || assessment === undefined) throw new RetrospectiveError("retro_invalid", `${input.run} の評価が読めないため確定できません`);
  const prev = currentTarget(file);
  const reason = input.reason?.trim();
  if (prev && prev.run === input.run && prev.assessmentVersion === assessmentVersion(assessment)) throw new RetrospectiveError("retro_invalid", `${input.run} は既に振り返りの対象です`);
  if (prev && !reason) throw new RetrospectiveError("retro_invalid", `対象を訂正するには理由（reason）を書いてください（今の対象: ${prev.run}）`);
  if (reason && reason.length > RETRO_LIMITS.reason) throw new RetrospectiveError("retro_invalid", `理由は ${RETRO_LIMITS.reason} 文字までです`);
  const n = Math.max(0, ...file.targets.map((t) => Number(t.id.slice(1)))) + 1;
  const target: RetroTarget = {
    id: `V${n}`,
    run: input.run,
    kind: cand.kind,
    assessmentVersion: assessmentVersion(assessment),
    risks: risks.map((text, index) => ({ index, text })),
    basis: cand.basis,
    at: ctx.now,
    ...(ctx.actor ? { by: ctx.actor } : {}),
    ...(reason ? { reason } : {}),
    ...(prev ? { replaces: prev.id } : {}),
  };
  return { ...file, version: file.version + 1, targets: [...file.targets, target] };
}

// --- 読む ---------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function readBasis(v: unknown): AdoptionBasis[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: AdoptionBasis[] = [];
  for (const x of v as unknown[]) {
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    if (!str(o.target) || !["present", "archived", "missing", "mismatch"].includes(String(o.state))) return undefined;
    out.push({ ...(str(o.key) ? { key: str(o.key) } : {}), target: str(o.target)!, state: o.state as AdoptionBasis["state"] });
  }
  return out;
}

function readTarget(v: unknown, at: string): RetroTarget | string {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const id = str(o.id) ?? "";
  if (!/^V\d+$/.test(id)) return `${at} の id が読めません（V1, V2, ...）`;
  const kind = o.kind;
  if (kind !== "tasks" && kind !== "split" && kind !== "legacy") return `${at}（${id}）の kind が読めません`;
  const risks = Array.isArray(o.risks) ? (o.risks as unknown[]) : undefined;
  if (!risks || risks.some((r) => !r || typeof r !== "object" || !Number.isInteger((r as Record<string, unknown>).index) || typeof (r as Record<string, unknown>).text !== "string"))
    return `${at}（${id}）の risks が読めません`;
  const basis = readBasis(o.basis);
  if (!str(o.run) || !str(o.assessmentVersion) || !str(o.at) || !basis) return `${at}（${id}）には run・assessmentVersion・basis・at が要ります`;
  return {
    id,
    run: str(o.run)!,
    kind,
    assessmentVersion: str(o.assessmentVersion)!,
    risks: risks.map((r) => ({ index: (r as { index: number }).index, text: (r as { text: string }).text })),
    basis,
    at: str(o.at)!,
    ...(str(o.by) ? { by: str(o.by) } : {}),
    ...(str(o.reason) ? { reason: str(o.reason) } : {}),
    ...(str(o.replaces) ? { replaces: str(o.replaces) } : {}),
  };
}

/** retrospective.json を読む（壊れていれば RetrospectiveError retro_unreadable。黙って空にしない） */
export function readRetrospective(raw: unknown): RetrospectiveFile {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (!o) throw new RetrospectiveError("retro_unreadable", "retrospective.json が読めません（オブジェクトではありません）");
  const version = Number.isInteger(o.version) && (o.version as number) >= 0 ? (o.version as number) : undefined;
  if (version === undefined) throw new RetrospectiveError("retro_unreadable", "retrospective.json の version が読めません");
  const targets: RetroTarget[] = [];
  for (const [i, t] of (Array.isArray(o.targets) ? (o.targets as unknown[]) : []).entries()) {
    const r = readTarget(t, `振り返りの対象 ${i + 1} 件目`);
    if (typeof r === "string") throw new RetrospectiveError("retro_unreadable", `retrospective.json: ${r}`);
    targets.push(r);
  }
  const judgments: RiskJudgment[] = [];
  for (const [i, j] of (Array.isArray(o.judgments) ? (o.judgments as unknown[]) : []).entries()) {
    const r = readJudgment(j, `リスクの確認 ${i + 1} 件目`);
    if (typeof r === "string") throw new RetrospectiveError("retro_unreadable", `retrospective.json: ${r}`);
    judgments.push(r);
  }
  return { ...o, version, targets, ...(judgments.length ? { judgments } : {}) };
}

function readEvidence(v: unknown): RetroEvidence | undefined {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const idx = Number.isInteger(o.index) ? (o.index as number) : undefined;
  if (o.kind === "task_review" && str(o.request) && str(o.task) && str(o.run) && (TASK_REVIEW_SECTIONS as readonly unknown[]).includes(o.section) && idx !== undefined && str(o.resultVersion) && typeof o.excerpt === "string")
    return { kind: "task_review", request: str(o.request)!, task: str(o.task)!, run: str(o.run)!, section: o.section as TaskReviewSection, index: idx, resultVersion: str(o.resultVersion)!, excerpt: o.excerpt };
  if (o.kind === "milestone_review" && str(o.milestone) && str(o.run) && (MILESTONE_REVIEW_SECTIONS as readonly unknown[]).includes(o.section) && idx !== undefined && str(o.resultVersion) && typeof o.excerpt === "string")
    return {
      kind: "milestone_review",
      milestone: str(o.milestone)!,
      run: str(o.run)!,
      section: o.section as MilestoneReviewSection,
      index: idx,
      resultVersion: str(o.resultVersion)!,
      excerpt: o.excerpt,
      ...(o.inputChanged === true ? { inputChanged: true } : {}),
      ...(str(o.reason) ? { reason: str(o.reason) } : {}),
    };
  if (o.kind === "rework" && str(o.request) && str(o.task) && str(o.history) && typeof o.excerpt === "string") return { kind: "rework", request: str(o.request)!, task: str(o.task)!, history: str(o.history)!, excerpt: o.excerpt };
  if (o.kind === "manual" && str(o.reference)) return { kind: "manual", reference: str(o.reference)!, ...(str(o.note) ? { note: str(o.note) } : {}) };
  return undefined;
}

function readJudgment(v: unknown, at: string): RiskJudgment | string {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const id = str(o.id) ?? "";
  if (!/^J\d+$/.test(id)) return `${at} の id が読めません（J1, J2, ...）`;
  const evidence = Array.isArray(o.evidence) ? (o.evidence as unknown[]).map(readEvidence) : undefined;
  if (!evidence || evidence.some((e) => !e)) return `${at}（${id}）の evidence が読めません`;
  if (!str(o.target) || !Number.isInteger(o.risk) || typeof o.riskText !== "string" || !isRiskState(o.state) || !str(o.at)) return `${at}（${id}）には target・risk・riskText・state・at が要ります`;
  return {
    id,
    target: str(o.target)!,
    risk: o.risk as number,
    riskText: o.riskText,
    state: o.state,
    ...(str(o.facts) ? { facts: str(o.facts) } : {}),
    ...(str(o.scope) ? { scope: str(o.scope) } : {}),
    evidence: evidence as RetroEvidence[],
    ...(str(o.reason) ? { reason: str(o.reason) } : {}),
    at: str(o.at)!,
    ...(str(o.by) ? { by: str(o.by) } : {}),
  };
}
