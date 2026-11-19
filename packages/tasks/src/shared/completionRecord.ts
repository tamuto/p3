import { readAcceptance, type AcceptanceCriterion, type AcceptanceEvidence } from "./acceptance.ts";
import { qualityPlain, readQuality, standardsFor, type QualityStandard, type QualityState } from "./quality.ts";
import { readRequirement, requestSubject, type CriterionSource, type RequirementSource } from "./requirementSource.ts";
import type { Request, Task } from "./types.ts";

/**
 * 完了の記録（完了・人の済み・対応済・完了済にしたときの条件の写し）の規則。CLI・API・画面で同じものを使う
 * （保存は core/requestOps.ts の createTask / updateTask / updateRequest がこれで作る）。
 *
 *   - タスク（task.md の completionRecords）と要望（request.md の completionRecords）に追記だけで持つ。状態と同じ rev の更新で書くので、
 *     片方だけが保存されることはない。再開・済みの解除でも消さず、再完了・再確認で新しい記録を足す。同じ状態の再保存・成果物の追記では足さない
 *   - 契機は、タスクの完了（task_done）・人の済み（task_checked。人の最終確認で、AI の承認ではない）・要望の対応済（request_resolved）・
 *     要望の完了済（request_done）。日時・保存した主体（by。アクターの名前）・書いた後の rev と状態を持つ
 *   - 写すもの: タスクは受け入れ基準（取り込んだ品質基準の版を含む）・証拠と根拠の種類・基準ごとの要求の根拠、要望の要求の根拠と確認履歴、
 *     品質の状態・版・作業先に当てはまる項目と除外（完了したときの最新の値。取り込んだときの版は基準の quality に残る）。要望は題・本文の hash・
 *     要求の根拠・品質の状態と版、完了の判定に使ったタスクと子の要望（ID・rev・状態・その時点の最新の記録 ID）
 *   - 参照先: 登録された参照先ごとに、取得した時点の HEAD のコミット・未コミットの変更の有無・取得時刻、取れなければ取れない理由
 *     （git でない・このマシンのパスなし・パスが無い・取得に失敗）。このマシンのパスは残さない。過去の Preflight の評価から推測して埋めない
 *   - 読めない条件（品質の設定・基準・根拠が壊れている）は problems として写し、完了は拒まない。記録の無い古いデータは補わず「記録なし」と読む
 *   - 複数のファイル（project.yaml・要望・タスク・参照先）を同じ瞬間に固定するものではない（それぞれ書く直前に読んだ値と取得時刻）
 *   - 直接編集で壊れた記録は黙って消さず completionProblems にし、関係のない更新ではファイルの元の値のまま書き戻す（keepRaw）。
 *     壊れている間は新しい記録を足さない（完了は拒まず、足せなかったことを知らせる）
 */

export const COMPLETION_TRIGGERS = ["task_done", "task_checked", "request_resolved", "request_done"] as const;
export type CompletionTrigger = (typeof COMPLETION_TRIGGERS)[number];
const isTrigger = (v: unknown): v is CompletionTrigger => typeof v === "string" && (COMPLETION_TRIGGERS as readonly string[]).includes(v);

export const COMPLETION_TRIGGER_LABEL: Record<CompletionTrigger, string> = {
  task_done: "タスクの完了",
  task_checked: "人の済み（人の最終確認）",
  request_resolved: "要望の対応済",
  request_done: "要望の完了済",
};

/** 参照先を取得した結果。ok: 取得できた / not_git: git のリポジトリでない / unregistered: このマシンのパスなし / missing: パスが無い / notdir: フォルダでない / failed: git の実行に失敗 */
export const REF_CAPTURE_STATES = ["ok", "not_git", "unregistered", "missing", "notdir", "failed"] as const;
export type RefCaptureState = (typeof REF_CAPTURE_STATES)[number];
const isRefState = (v: unknown): v is RefCaptureState => typeof v === "string" && (REF_CAPTURE_STATES as readonly string[]).includes(v);

export const REF_CAPTURE_LABEL: Record<RefCaptureState, string> = {
  ok: "取得",
  not_git: "git でない",
  unregistered: "このマシンのパスなし",
  missing: "パスが無い",
  notdir: "フォルダでない",
  failed: "取得に失敗",
};

/** 参照先1件の取得（このマシンのパスは含めない） */
export interface RefCapture {
  name: string;
  state: RefCaptureState;
  /** HEAD のコミット（ok のとき） */
  commit?: string;
  /** 参照先のフォルダに未コミットの変更（追跡していないファイルを含む）があったか。取れなければ無い */
  dirty?: boolean;
  /** 取得した日時 */
  at: string;
  /** 取れなかった理由（パスは含めない） */
  reason?: string;
}

/** 品質基準の条件（完了したときの最新の値） */
export interface QualityCondition {
  state: "unset" | "set" | "invalid";
  /** 設定全体の版 */
  version: string;
  /** タスクの作業先（タスクの記録だけ。null は作業先なし） */
  repo?: string | null;
  /** 作業先に当てはまる品質基準（除外したものは exempt を持つ。タスクの記録で set のときだけ） */
  standards?: QualityStandard[];
  /** 読めない理由（invalid のとき） */
  problems?: string[];
}

/** 受け入れ基準の条件。読めなかったら problems だけ */
export interface AcceptanceCondition {
  criteria?: AcceptanceCriterion[];
  evidence?: AcceptanceEvidence[];
  sources?: CriterionSource[];
  problems?: string[];
}

/** 要望の要求の根拠の条件（確認履歴を含む）。読めなかったら problems だけ */
export interface RequirementCondition {
  sources?: RequirementSource[];
  problems?: string[];
}

/** 完了の判定に使った配下（タスク・子の要望）1件 */
export interface CompletionPart {
  id: string;
  rev: number;
  status: string;
  /** 人の済みがあったか（タスク） */
  checked?: boolean;
  /** その時点の最新の完了の記録の ID（無ければ記録なし） */
  record?: string;
}

/** 完了の記録1件 */
export interface CompletionRecord {
  /** タスク・要望の中で安定した ID（C1, C2, ...） */
  id: string;
  trigger: CompletionTrigger;
  at: string;
  /** 保存した主体（ai:claude / human:<名前>。人の済みでも保存した主体をそのまま残す） */
  by?: string;
  /** 書いた後の対象の rev */
  rev: number;
  /** 書いた後の状態 */
  status: string;
  /** タスク: 人の済みがあるか */
  checked?: boolean;
  quality: QualityCondition;
  /** 要望の要求の根拠（タスクは所属する要望の値） */
  requirement?: RequirementCondition;
  /** タスクの受け入れ基準・証拠・基準ごとの根拠（無ければ受け入れ基準なし） */
  acceptance?: AcceptanceCondition;
  /** 要望: 題（写し）と、題と本文の hash（requirementSource.ts の requestSubject） */
  title?: string;
  subject?: string;
  /** 要望: 判定に使ったタスクと子の要望 */
  tasks?: CompletionPart[];
  children?: CompletionPart[];
  /** 参照先（無いのは取得していない） */
  refs?: RefCapture[];
}

export interface CompletionState {
  completionRecords?: CompletionRecord[];
  /** 直接編集で読めなかった理由（ファイルには書かない。あれば新しい記録を足さない） */
  completionProblems?: string[];
}

/** ファイルに書く項目（壊れていたら元の値のまま書き戻す） */
export const COMPLETION_KEYS = ["completionRecords"] as const;

export const COMPLETION_ID_RE = /^C\d+$/;

// --- 読む ---------------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : str(v));
const int = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined);

function readQualityCondition(v: unknown): QualityCondition | string {
  const o = obj(v);
  if (!o) return "quality が読めません";
  const state = o.state;
  if (state !== "unset" && state !== "set" && state !== "invalid") return "quality.state が読めません（unset / set / invalid）";
  const version = typeof o.version === "string" ? o.version : undefined;
  if (version === undefined) return "quality.version がありません";
  const out: QualityCondition = { state, version };
  if ("repo" in o) out.repo = typeof o.repo === "string" && o.repo ? o.repo : null;
  if (o.standards !== undefined) {
    const q = readQuality({ standards: o.standards });
    if (q.state !== "set") return `quality.standards が読めません: ${q.state === "invalid" ? q.problems.join(" / ") : ""}`;
    out.standards = q.config.standards;
  }
  if (o.problems !== undefined) {
    const p = strList(o.problems);
    if (!p) return "quality.problems が読めません";
    out.problems = p;
  }
  return out;
}

function readAcceptanceCondition(v: unknown): AcceptanceCondition | string {
  const o = obj(v);
  if (!o) return "acceptance が読めません";
  if (o.problems !== undefined) {
    const p = strList(o.problems);
    return p ? { problems: p } : "acceptance.problems が読めません";
  }
  const a = readAcceptance({ acceptanceCriteria: o.criteria, acceptanceEvidence: o.evidence, acceptanceSources: o.sources });
  if (a.acceptanceProblems?.length) return `acceptance が読めません: ${a.acceptanceProblems.join(" / ")}`;
  return {
    ...(a.acceptanceCriteria?.length ? { criteria: a.acceptanceCriteria } : {}),
    ...(a.acceptanceEvidence?.length ? { evidence: a.acceptanceEvidence } : {}),
    ...(a.acceptanceSources?.length ? { sources: a.acceptanceSources } : {}),
  };
}

function readRequirementCondition(v: unknown): RequirementCondition | string {
  const o = obj(v);
  if (!o) return "requirement が読めません";
  if (o.problems !== undefined) {
    const p = strList(o.problems);
    return p ? { problems: p } : "requirement.problems が読めません";
  }
  const r = readRequirement({ requirementSources: o.sources });
  if (r.requirementProblems?.length) return `requirement が読めません: ${r.requirementProblems.join(" / ")}`;
  return r.requirementSources?.length ? { sources: r.requirementSources } : {};
}

function readRefs(v: unknown): RefCapture[] | string {
  if (!Array.isArray(v)) return "refs が並びになっていません";
  const out: RefCapture[] = [];
  for (const raw of v as unknown[]) {
    const o = obj(raw);
    const name = str(o?.name);
    const at = iso(o?.at);
    if (!o || !name || !at || !isRefState(o.state)) return "refs の項目が読めません（name・state・at が要ります）";
    if (o.commit !== undefined && !/^[0-9a-f]{7,64}$/.test(String(o.commit))) return `refs の ${name} の commit が読めません`;
    if (o.dirty !== undefined && typeof o.dirty !== "boolean") return `refs の ${name} の dirty が読めません`;
    out.push({ name, state: o.state, ...(o.commit !== undefined ? { commit: String(o.commit) } : {}), ...(typeof o.dirty === "boolean" ? { dirty: o.dirty } : {}), at, ...(str(o.reason) ? { reason: str(o.reason) } : {}) });
  }
  return out;
}

function readParts(v: unknown, key: string): CompletionPart[] | string {
  if (!Array.isArray(v)) return `${key} が並びになっていません`;
  const out: CompletionPart[] = [];
  for (const raw of v as unknown[]) {
    const o = obj(raw);
    const id = str(o?.id);
    const rev = int(o?.rev);
    const status = str(o?.status);
    if (!o || !id || rev === undefined || !status) return `${key} の項目が読めません（id・rev・status が要ります）`;
    if (o.record !== undefined && !COMPLETION_ID_RE.test(String(o.record))) return `${key} の ${id} の record が読めません`;
    out.push({ id, rev, status, ...(typeof o.checked === "boolean" ? { checked: o.checked } : {}), ...(o.record !== undefined ? { record: String(o.record) } : {}) });
  }
  return out;
}

function readRecord(raw: unknown, at: string): CompletionRecord | string {
  const o = obj(raw);
  if (!o) return `${at} が読めません`;
  const id = str(o.id) ?? "";
  const label = `${at}${id ? `（${id}）` : ""}`;
  if (!COMPLETION_ID_RE.test(id)) return `${label} の id が読めません（C1, C2, ...）`;
  if (!isTrigger(o.trigger)) return `${label} の trigger が読めません（${COMPLETION_TRIGGERS.join(" / ")}）`;
  const when = iso(o.at);
  if (!when) return `${label} の at がありません`;
  const rev = int(o.rev);
  if (rev === undefined) return `${label} の rev が読めません`;
  const status = str(o.status);
  if (!status) return `${label} の status がありません`;
  const quality = readQualityCondition(o.quality);
  if (typeof quality === "string") return `${label}: ${quality}`;
  const rec: CompletionRecord = { id, trigger: o.trigger, at: when, ...(str(o.by) ? { by: str(o.by) } : {}), rev, status, ...(typeof o.checked === "boolean" ? { checked: o.checked } : {}), quality };
  if (o.requirement !== undefined) {
    const r = readRequirementCondition(o.requirement);
    if (typeof r === "string") return `${label}: ${r}`;
    rec.requirement = r;
  }
  if (o.acceptance !== undefined) {
    const a = readAcceptanceCondition(o.acceptance);
    if (typeof a === "string") return `${label}: ${a}`;
    rec.acceptance = a;
  }
  if (o.title !== undefined) rec.title = String(o.title);
  if (o.subject !== undefined) rec.subject = String(o.subject);
  for (const key of ["tasks", "children"] as const) {
    if (o[key] === undefined) continue;
    const p = readParts(o[key], key);
    if (typeof p === "string") return `${label}: ${p}`;
    rec[key] = p;
  }
  if (o.refs !== undefined) {
    const r = readRefs(o.refs);
    if (typeof r === "string") return `${label}: ${r}`;
    rec.refs = r;
  }
  return rec;
}

/** frontmatter の completionRecords を読む。無ければ何も足さない（記録の無い古いデータはそのまま「記録なし」） */
export function readCompletion(d: Record<string, unknown>): CompletionState {
  if (d.completionRecords === undefined || d.completionRecords === null) return {};
  if (!Array.isArray(d.completionRecords)) return { completionProblems: ["completionRecords が並びになっていません"] };
  const problems: string[] = [];
  const list: CompletionRecord[] = [];
  for (const [i, raw] of (d.completionRecords as unknown[]).entries()) {
    const r = readRecord(raw, `完了の記録 ${i + 1} 件目`);
    if (typeof r === "string") problems.push(r);
    else if (list.some((x) => x.id === r.id)) problems.push(`完了の記録の id が重複しています: ${r.id}`);
    else list.push(r);
  }
  return { ...(list.length ? { completionRecords: list } : {}), ...(problems.length ? { completionProblems: problems } : {}) };
}

// --- 作る ---------------------------------------------------------------------

/** 次の記録の ID（消さないので最大の番号の次） */
export function nextCompletionId(list: readonly CompletionRecord[] | undefined): string {
  const max = Math.max(0, ...(list ?? []).map((r) => Number(r.id.slice(1))));
  return `C${max + 1}`;
}

/** 最新の記録（無ければ undefined） */
export const latestCompletion = (list: readonly CompletionRecord[] | undefined): CompletionRecord | undefined => list?.at(-1);

/**
 * タスクの書く前（prev。作るときは無い）と書いた後（next）から、足す記録の契機を決める。
 * acceptanceChanged: この更新で基準・証拠・基準の根拠の中身が変わった（済みのまま中身を変えて済みを付け直したら、新しい人の済みの記録にする）
 */
export function taskTriggers(prev: Pick<Task, "status" | "checkedAt"> | undefined, next: Pick<Task, "status" | "checkedAt">, acceptanceChanged: boolean): CompletionTrigger[] {
  if (next.status !== "done") return [];
  const out: CompletionTrigger[] = [];
  const wasDone = prev?.status === "done";
  if (!wasDone) out.push("task_done");
  if (next.checkedAt && (!wasDone || !prev?.checkedAt || acceptanceChanged)) out.push("task_checked");
  return out;
}

/** 要望の状態の変化から、足す記録の契機を決める */
export function requestTriggers(prev: Request["status"], next: Request["status"]): CompletionTrigger[] {
  if (prev === next) return [];
  if (next === "resolved") return ["request_resolved"];
  if (next === "done") return ["request_done"];
  return [];
}

/** 記録を作るときの周りの値（書く直前に読んだもの） */
export interface CompletionContext {
  at: string;
  by?: string;
  quality: QualityState | undefined;
  qualityVersion: string | undefined;
  /** 参照先の取得（取得していなければ無い） */
  refs?: RefCapture[];
}

/** 品質の条件（タスクなら作業先に当てはまる項目と除外を写す） */
export function qualityCondition(state: QualityState | undefined, version: string | undefined, task?: { repo: string | null }): QualityCondition {
  const st = state ?? { state: "unset" as const };
  const base = { state: st.state, version: version ?? "", ...(task ? { repo: task.repo } : {}) };
  if (st.state === "invalid") return { ...base, problems: [...st.problems] };
  if (st.state !== "set" || !task) return base;
  const { applies, exempt } = standardsFor(st.config, task.repo);
  const hit = st.config.standards.filter((s) => applies.includes(s) || exempt.includes(s));
  // 書く形（qualityPlain）にそろえて写す（読み直しても同じ値になる）
  return { ...base, standards: (qualityPlain({ standards: hit }).standards as QualityStandard[]).map((s) => structuredClone(s)) };
}

const requirementOf = (r: Pick<Request, "requirementSources" | "requirementProblems"> | undefined): RequirementCondition | undefined => {
  if (!r) return undefined;
  if (r.requirementProblems?.length) return { problems: [...r.requirementProblems] };
  return r.requirementSources?.length ? { sources: structuredClone(r.requirementSources) } : undefined;
};

/** タスクの記録（task は書いた後の値。rev は書いた後の rev） */
export function taskCompletionRecord(id: string, trigger: CompletionTrigger, task: Task, rev: number, request: Pick<Request, "requirementSources" | "requirementProblems"> | undefined, ctx: CompletionContext): CompletionRecord {
  let acceptance: AcceptanceCondition | undefined;
  if (task.acceptanceProblems?.length) acceptance = { problems: [...task.acceptanceProblems] };
  else if (task.acceptanceCriteria?.length || task.acceptanceEvidence?.length || task.acceptanceSources?.length) {
    acceptance = {
      ...(task.acceptanceCriteria?.length ? { criteria: structuredClone(task.acceptanceCriteria) } : {}),
      ...(task.acceptanceEvidence?.length ? { evidence: structuredClone(task.acceptanceEvidence) } : {}),
      ...(task.acceptanceSources?.length ? { sources: structuredClone(task.acceptanceSources) } : {}),
    };
  }
  const requirement = requirementOf(request);
  return {
    id,
    trigger,
    at: ctx.at,
    ...(ctx.by ? { by: ctx.by } : {}),
    rev,
    status: task.status,
    checked: !!task.checkedAt,
    quality: qualityCondition(ctx.quality, ctx.qualityVersion, task),
    ...(requirement ? { requirement } : {}),
    ...(acceptance ? { acceptance } : {}),
    ...(ctx.refs ? { refs: structuredClone(ctx.refs) } : {}),
  };
}

/** 要望の記録（request は書いた後の値。tasks・children は判定に使った配下） */
export function requestCompletionRecord(
  id: string,
  trigger: CompletionTrigger,
  request: Request,
  rev: number,
  parts: { tasks: readonly Task[]; children: readonly Request[] },
  ctx: CompletionContext,
): CompletionRecord {
  const requirement = requirementOf(request);
  const part = (x: Task | Request): CompletionPart => {
    const rec = latestCompletion(x.completionRecords);
    return { id: x.id, rev: x.rev, status: x.status, ...(rec ? { record: rec.id } : {}) };
  };
  return {
    id,
    trigger,
    at: ctx.at,
    ...(ctx.by ? { by: ctx.by } : {}),
    rev,
    status: request.status,
    quality: qualityCondition(ctx.quality, ctx.qualityVersion),
    ...(requirement ? { requirement } : {}),
    title: request.title,
    subject: requestSubject(request),
    tasks: parts.tasks.map((t) => ({ ...part(t), checked: !!t.checkedAt })),
    children: parts.children.map(part),
    ...(ctx.refs ? { refs: structuredClone(ctx.refs) } : {}),
  };
}

/** 記録を足した値（壊れた記録があれば足さずに undefined） */
export function appendCompletion(cur: CompletionState, make: (id: string) => CompletionRecord): CompletionRecord[] | undefined {
  if (cur.completionProblems?.length) return undefined;
  const list = cur.completionRecords ?? [];
  return [...list, make(nextCompletionId(list))];
}

/** 壊れた記録のため記録を足せなかったときの知らせ */
export const COMPLETION_SKIPPED = "完了の記録が読めないため、今回の記録は残していません（状態は変えました）。ファイルの completionRecords を直してください";
