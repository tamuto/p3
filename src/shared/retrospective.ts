import type { PreflightRun, RequestStatus } from "./types.ts";

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

/** retrospective.json の中身 */
export interface RetrospectiveFile {
  /** 保存するたびに 1 ずつ上がる版（無ければ 0） */
  version: number;
  targets: RetroTarget[];
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
  return { ...o, version, targets };
}
