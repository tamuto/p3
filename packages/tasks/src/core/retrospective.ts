import { join } from "node:path";
import { reworkLine } from "../shared/reworkHistory.ts";

/** タスク（今かアーカイブ）の手戻りの履歴の 1 件（根拠を保存するときと、保存した根拠を照らすときで同じ引き方） */
const reworkEntry = (t: Task | undefined, id: string) => t?.reworkHistory?.find((e) => e.id === id);
import type { Task } from "../shared/types.ts";
import {
  addJudgment,
  assessmentVersion,
  JUDGMENT_LIMITS,
  latestJudgment,
  MILESTONE_REVIEW_SECTIONS,
  riskCounts,
  TASK_REVIEW_SECTIONS,
  type EvidenceCheck,
  type EvidenceRef,
  type RetroEvidence,
  type RetroRiskView,
  type RetrospectiveView,
  type RiskState,
  confirmTarget,
  currentTarget,
  readRetrospective,
  retroCandidates,
  RetrospectiveError,
  type RetroCandidate,
  type RetrospectiveFile,
} from "../shared/retrospective.ts";

export type { EvidenceRef, RetrospectiveView } from "../shared/retrospective.ts";
import type { P3Context } from "./context.ts";
import { getArchivedTask, listArchivedTasks } from "./store/archivedTasks.ts";
import { NotFoundError } from "./store/collection.ts";
import { withFileLock } from "@infodb/p3-kit/fsutil.ts";
import { readJsonRecord, writeJsonRecord } from "./store/jsonRecord.ts";

/**
 * 要望の振り返りの保存と読み取り（規則は shared/retrospective.ts）。記録は requests/<要望ID>/retrospective.json で、要望のロック
 * （requestLock。要望・タスクの保存と同じ）の中で、読み直してから版を照らして書く。読み取りはファイルを書かない
 */

export const RETRO_FILE = "retrospective.json";

const pathOf = (ctx: P3Context, rid: string) => join(ctx.ws.requestsDir, rid, RETRO_FILE);

/** 記録を読む（無ければ空。JSON として読めなければ retro_unreadable、ほかの読めない理由はそのまま投げる） */
export function loadRetrospective(ctx: P3Context, rid: string): Promise<RetrospectiveFile> {
  return readJsonRecord<RetrospectiveFile>(pathOf(ctx, rid), {
    missing: () => ({ version: 0, targets: [] }),
    invalidJson: (m) => {
      throw new RetrospectiveError("retro_unreadable", `retrospective.json が JSON として読めません: ${m}（ファイルを直してください）`);
    },
    shape: readRetrospective,
  });
}

/**
 * 記録を変える（確定・訂正・リスクの確認で共通）。要望のロックの中で、要望があること（アーカイブで移した後のフォルダに書き戻さない）を確かめ、
 * 読み直して版を照らし（違えば retro_conflict）、change が返した記録を置き換えで書く。書いた後に変更を知らせ、今の表示を返す
 */
async function changeRetrospective(
  ctx: P3Context,
  rid: string,
  expectedVersion: number | undefined,
  change: (file: RetrospectiveFile) => Promise<RetrospectiveFile>,
): Promise<RetrospectiveView> {
  ctx.ws.requests.require(rid);
  await withFileLock(
    ctx.ws.requestLock(rid),
    async () => {
      if ("missing" in (await ctx.ws.requests.peek(rid))) throw new NotFoundError(rid);
      const file = await loadRetrospective(ctx, rid);
      if (expectedVersion !== undefined && expectedVersion !== file.version) {
        throw new RetrospectiveError("retro_conflict", `振り返りの記録が他で変わりました（版 ${expectedVersion} → ${file.version}）。読み直してからやり直してください`);
      }
      await writeJsonRecord(pathOf(ctx, rid), await change(file));
    },
    { busyMessage: "別のプロセスがこの要望を保存中です。少し待ってやり直してください" },
  );
  ctx.ws.emit({ type: "changed", kind: "request", request: rid });
  return retrospectiveView(ctx, rid);
}

/** 候補（新しい順）。runs と照らすタスク・子の要望はディスクと読み込んだ値から */
export async function retrospectiveCandidates(ctx: P3Context, rid: string): Promise<{ candidates: RetroCandidate[]; none?: string; runs: Awaited<ReturnType<typeof ctx.preflight.list>> }> {
  const request = ctx.ws.requests.require(rid);
  const runs = await ctx.preflight.list(rid);
  const archived = new Set((await listArchivedTasks(ctx.ws, rid)).tasks.map((t) => t.id));
  const tasks = ctx.ws.tasksOf(rid);
  const lookup = {
    task: (tid: string) => (tasks.get(tid) ? ("present" as const) : archived.has(tid) ? ("archived" as const) : ("missing" as const)),
    child: (id: string) => {
      const c = ctx.ws.requests.get(id);
      return c ? { splitFrom: c.splitFrom, parent: c.parent } : undefined;
    },
  };
  return { ...retroCandidates(rid, request.status, runs, lookup), runs };
}

export async function retrospectiveView(ctx: P3Context, rid: string): Promise<RetrospectiveView> {
  const file = await loadRetrospective(ctx, rid);
  const { candidates, none } = await retrospectiveCandidates(ctx, rid);
  const target = currentTarget(file);
  const judgments = file.judgments ?? [];
  const risks = (target?.risks ?? []).map((r): RetroRiskView => {
    const j = latestJudgment(file, target!.id, r.index);
    return { index: r.index, text: r.text, state: j?.state ?? "unchecked", ...(j ? { judgment: j } : {}), history: judgments.filter((x) => x.target === target!.id && x.risk === r.index) };
  });
  const checks: Record<string, EvidenceCheck[]> = {};
  for (const j of judgments) checks[j.id] = await Promise.all(j.evidence.map((e) => checkEvidence(ctx, e)));
  return { version: file.version, ...(target ? { target } : {}), targets: file.targets, candidates, ...(none ? { none } : {}), risks, counts: riskCounts(file), judgments, checks };
}

// --- リスクの確認の根拠 -----------------------------------------------------------

const bad = (m: string) => new RetrospectiveError("retro_invalid", m);
const clip = (s: string) => (s.length > JUDGMENT_LIMITS.excerpt ? `${s.slice(0, JUDGMENT_LIMITS.excerpt)}…` : s);

/** 結果の項目と位置から所見の文を取り出す（無ければ undefined） */
function findingOf(result: Record<string, unknown>, section: string, index: number): string | undefined {
  if (section === "overall") return index === 0 && typeof result.overall === "string" ? result.overall : undefined;
  const list = result[section];
  if (!Array.isArray(list) || index < 0 || index >= list.length) return undefined;
  const x = list[index] as Record<string, unknown> | string;
  if (typeof x === "string") return x;
  const head = [x.item ?? x.unit ?? x.standard, x.verdict].filter((v) => typeof v === "string").join(": ");
  return [head, typeof x.reason === "string" ? x.reason : typeof x.text === "string" ? x.text : ""].filter(Boolean).join(" ");
}

/** 所見がこの要望を根拠に挙げているか（マイルストーンレビューの所見の evidence に要望 ID かそのタスクの参照がある） */
function citesRequest(result: Record<string, unknown>, section: string, index: number, rid: string): boolean {
  const list = result[section];
  const x = Array.isArray(list) ? (list[index] as Record<string, unknown> | undefined) : undefined;
  const ev = x && Array.isArray(x.evidence) ? (x.evidence as unknown[]) : [];
  return ev.some((e) => typeof e === "string" && (e === rid || e.startsWith(`${rid}/`)));
}

/** タスクを今の・アーカイブから引く（無ければ undefined） */
async function taskOf(ctx: P3Context, rid: string, tid: string): Promise<Task | undefined> {
  return ctx.ws.tasksOf(rid).get(tid) ?? (await getArchivedTask(ctx.ws, rid, tid).catch(() => undefined));
}

/** 根拠の指定を今の記録と照らして、保存する根拠にする（範囲外・見つからない・所見が無いなどは retro_invalid） */
export async function resolveEvidence(ctx: P3Context, rid: string, ref: EvidenceRef): Promise<RetroEvidence> {
  if (ref.kind === "manual") {
    const reference = ref.reference?.trim();
    if (!reference) throw bad("人が書く参照（reference）が空です");
    return { kind: "manual", reference: clip(reference), ...(ref.note?.trim() ? { note: clip(ref.note.trim()) } : {}) };
  }
  if (ref.kind === "rework") {
    const t = await taskOf(ctx, rid, ref.task);
    if (!t) throw bad(`${rid}/${ref.task} はこの要望のタスクにありません`);
    const h = reworkEntry(t, ref.history);
    if (!h) throw bad(`${t.id} の手戻りの履歴に ${ref.history} はありません`);
    return { kind: "rework", request: rid, task: t.id, history: h.id, excerpt: clip(reworkLine(h)) };
  }
  const index = ref.index ?? 0;
  if (ref.kind === "task_review") {
    if (!(TASK_REVIEW_SECTIONS as readonly string[]).includes(ref.section)) throw bad(`タスクレビューの所見の項目は ${TASK_REVIEW_SECTIONS.join(" / ")} です`);
    if (!(await taskOf(ctx, rid, ref.task))) throw bad(`${rid}/${ref.task} はこの要望のタスクにありません（ほかの要望のレビューは結び付けられません）`);
    const rec = await ctx.ws.taskReviews.get(`${rid}/${ref.task}`, ref.run).catch(() => undefined);
    if (!rec?.result) throw bad(`${rid}/${ref.task} のレビュー ${ref.run} の結果がありません`);
    const text = findingOf(rec.result as unknown as Record<string, unknown>, ref.section, index);
    if (text === undefined) throw bad(`レビュー ${ref.run} の ${ref.section}[${index}] に所見がありません`);
    return { kind: "task_review", request: rid, task: ref.task, run: ref.run, section: ref.section, index, resultVersion: assessmentVersion(rec.result), excerpt: clip(text) };
  }
  if (!(MILESTONE_REVIEW_SECTIONS as readonly string[]).includes(ref.section)) throw bad(`マイルストーンレビューの所見の項目は ${MILESTONE_REVIEW_SECTIONS.join(" / ")} です`);
  const rec = await ctx.ws.milestoneReviews.get(ref.milestone, ref.run).catch(() => undefined);
  if (!rec?.result || !rec.input) throw bad(`マイルストーン ${ref.milestone} のレビュー ${ref.run} の結果がありません`);
  if (!rec.input.requests.some((r) => r.id === rid)) throw bad(`レビュー ${ref.run} の材料で、${rid} は直接の対象ではありません（範囲外の所見は結び付けられません）`);
  const result = rec.result as unknown as Record<string, unknown>;
  const text = findingOf(result, ref.section, index);
  if (text === undefined) throw bad(`レビュー ${ref.run} の ${ref.section}[${index}] に所見がありません`);
  const reason = ref.reason?.trim();
  if (!citesRequest(result, ref.section, index, rid) && !reason) throw bad(`この所見は ${rid} を根拠に挙げていません。全体に関わる所見を結び付けるには、この要望と結び付く理由（reason）を書いてください`);
  return {
    kind: "milestone_review",
    milestone: ref.milestone,
    run: ref.run,
    section: ref.section,
    index,
    resultVersion: assessmentVersion(rec.result),
    excerpt: clip(text),
    ...(rec.run.inputChanged ? { inputChanged: true } : {}),
    ...(reason ? { reason: clip(reason) } : {}),
  };
}

/** 保存した根拠を今の記録と照らす（ファイルは書かない） */
export async function checkEvidence(ctx: P3Context, e: RetroEvidence): Promise<EvidenceCheck> {
  if (e.kind === "manual") return "manual";
  if (e.kind === "rework") return reworkEntry(await taskOf(ctx, e.request, e.task), e.history) ? "ok" : "missing";
  const rec = e.kind === "task_review" ? await ctx.ws.taskReviews.get(`${e.request}/${e.task}`, e.run).catch(() => undefined) : await ctx.ws.milestoneReviews.get(e.milestone, e.run).catch(() => undefined);
  if (!rec?.result) return "missing";
  return assessmentVersion(rec.result) === e.resultVersion ? "ok" : "changed";
}

/**
 * リスクの確認を記録する（追記。今の確定した対象のリスクだけ）。根拠は保存するときに照らして抜粋と版を写す。
 * expectedVersion が違えば retro_conflict、規則に合わない・範囲外の根拠は retro_invalid（どちらも何も書かない）
 */
export async function judgeRisk(
  ctx: P3Context,
  rid: string,
  input: { risk: number; state: RiskState; facts?: string; scope?: string; reason?: string; evidence: EvidenceRef[] },
  opts: { expectedVersion?: number; actor?: string } = {},
): Promise<RetrospectiveView> {
  return changeRetrospective(ctx, rid, opts.expectedVersion, async (file) => {
    const evidence: RetroEvidence[] = [];
    for (const ref of input.evidence) evidence.push(await resolveEvidence(ctx, rid, ref));
    return addJudgment(file, { ...input, evidence }, { now: new Date().toISOString(), actor: opts.actor });
  });
}

/**
 * 振り返りの対象を確定する（訂正は理由つきで追記）。expectedVersion が今の版と違えば retro_conflict、候補でない・評価が無いなどは
 * retro_invalid（どちらも何も書かない）
 */
export async function confirmRetrospectiveTarget(
  ctx: P3Context,
  rid: string,
  input: { run: string; reason?: string },
  opts: { expectedVersion?: number; actor?: string } = {},
): Promise<RetrospectiveView> {
  return changeRetrospective(ctx, rid, opts.expectedVersion, async (file) => {
    const { candidates, none, runs } = await retrospectiveCandidates(ctx, rid);
    const runOf = (id: string) => runs.find((r) => r.id === id);
    return confirmTarget(file, input, {
      candidates,
      none,
      risksOf: (id) => runOf(id)?.assessment?.risks,
      assessmentOf: (id) => runOf(id)?.assessment,
      now: new Date().toISOString(),
      actor: opts.actor,
    });
  });
}
