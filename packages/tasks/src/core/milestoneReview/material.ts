import { createHash } from "node:crypto";
import {
  PURPOSE_UNIT_ID,
  REVIEW_SCOPE,
  REVIEW_SCOPE_RECORDS_ONLY,
  type ReviewCodeRef,
  type ReviewContextRequest,
  type ReviewInput,
  type ReviewInputRequest,
  type ReviewUnit,
  type ReviewWarning,
} from "../../shared/milestoneReview.ts";
import type { Milestone } from "../../shared/types.ts";
import { qualitySnapshot } from "../../shared/quality.ts";
import type { ResolvedRef } from "../repoRefs.ts";
import { hierarchyNow } from "../requestStatus.ts";
import { Workspace } from "../store/workspace.ts";
import { reviewCode } from "./code.ts";

/**
 * マイルストーンレビューの比較材料を取り出す。リリースノートの材料（releaseNotes/material.ts）とは別の規則で、あちらの収録の
 * 条件は変えない。
 *
 *   - 比べるのは保存してある目的・予定機能（画面の書きかけは使わない）。比較単位は予定機能。予定機能が無く目的だけなら目的そのもの
 *   - 確かめる対象は参照先のコード（code.ts。Codex に読むだけでマウントする）。参照先ごとの HEAD・未コミットの変更・
 *     タスクに残したコミットを固定する。読める参照先が無ければ警告し、範囲を「記録だけ」にする
 *   - 材料は、マイルストーンに直接属する要望の全部の状態（下書き・進行中・対応済・完了済・見送り）。要望の本文、各タスクの本文・状態・
 *     変更の記録・成果物の参照の文字列。未完了・記録なしも省かない（見送りは状態のまま残し、成果と混同しないよう評価の指示で扱う）
 *   - 親子: 親・子が別のマイルストーンなら文脈（context）として ID・題・状態だけを持ち、材料には数えない（二重に数えない）
 *   - アーカイブした要望は通常の一覧と同じく含めない。成果物の URL・添付の中身は読まない
 *   - 読めない要望は所属が分からないので全体の警告、読めないタスクはその要望の欠落の警告
 *   - hash には目的・予定機能・所属・本文・状態・記録・関係・欠落を入れ、抽出の日時は入れない
 *
 * 抽出のたびにディスクから読み直した別の Workspace を使う（画面・CLI のキャッシュに左右されない）。複数のファイルを同じ時点で
 * 読んだとは保証しない（抽出の始めと終わりを残す）。何も書かない。
 */
export async function extractReviewInput(dataDir: string, mid: string, refs: readonly ResolvedRef[] = []): Promise<ReviewInput> {
  const extractedAt = new Date().toISOString();
  const snap = new Workspace(dataDir);
  await snap.load();
  const records = reviewInputOf(snap, mid, extractedAt);
  const { code, warnings } = await reviewCode(refs, records.requests, dataDir);
  return withCode(records, code, warnings);
}

/** 記録の材料にコードの材料を足す（範囲・警告・hash も合わせる） */
export function withCode(i: ReviewInput, code: ReviewCodeRef[], warnings: ReviewWarning[] = []): ReviewInput {
  const body = {
    milestone: i.milestone,
    units: i.units,
    requests: i.requests,
    context: i.context,
    warnings: [...i.warnings, ...warnings],
    code,
    ...(i.quality ? { quality: i.quality } : {}),
    scope: code.some((c) => c.status === "ok") ? REVIEW_SCOPE : REVIEW_SCOPE_RECORDS_ONLY,
  };
  return { ...body, extractedAt: i.extractedAt, extractedUntil: new Date().toISOString(), hash: reviewInputHash(body) };
}

const byId = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** 比較単位（予定機能。無ければ目的） */
export function reviewUnits(m: Pick<Milestone, "purpose" | "goals"> | undefined): ReviewUnit[] {
  if (m?.goals?.length) return m.goals.map((g) => ({ id: g.id, text: g.text }));
  return m?.purpose ? [{ id: PURPOSE_UNIT_ID, text: m.purpose }] : [];
}

export function reviewInputOf(ws: Workspace, mid: string, extractedAt = new Date().toISOString()): ReviewInput {
  const m = ws.project.milestones.find((x) => x.id === mid);
  const warnings: ReviewWarning[] = [];
  if (!m) warnings.push({ code: "unknown_milestone", target: mid, message: `マイルストーン ${mid} は project.yaml にありません` });
  else if (!m.purpose && !m.goals?.length) {
    warnings.push({ code: "no_goals", target: mid, message: `マイルストーン ${mid} に目的も予定機能もありません（マイルストーンのタブか p3 milestone purpose / goal add で書けます）` });
  }
  for (const [id, e] of ws.requests.errors) {
    warnings.push({ code: "broken_request", target: `requests/${id}/request.md`, message: `要望のファイルを読めないため、このマイルストーンに属するか分かりません: ${e}` });
  }
  const h = hierarchyNow(ws);
  const members = ws.requests
    .list()
    .filter((r) => r.milestone === mid)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || byId(a.id, b.id));
  const memberIds = new Set(members.map((r) => r.id));
  const requests: ReviewInputRequest[] = [];
  const context: ReviewContextRequest[] = [];
  const addContext = (c: ReviewContextRequest) => {
    if (!context.some((x) => x.id === c.id && x.of === c.of && x.relation === c.relation)) context.push(c);
  };
  for (const r of members) {
    const col = ws.tasksOf(r.id);
    const broken = [...col.errors.keys()].sort(byId);
    for (const t of broken) warnings.push({ code: "broken_task", target: `${r.id}/${t}`, message: `${r.id}/${t} のタスクのファイルを読めません（材料から欠けています）` });
    const tasks = [...col.list()].sort((a, b) => byId(a.id, b.id));
    for (const t of tasks) {
      if (t.status === "done" && !t.record?.trim()) warnings.push({ code: "missing_record", target: t.ref, message: `${t.ref} は完了していますが変更の記録がありません` });
    }
    const kids = h.children(r.id);
    requests.push({
      id: r.id,
      title: r.title,
      status: r.status,
      body: r.body.trim(),
      ...(r.parent ? { parent: r.parent } : {}),
      ...(kids.length ? { children: kids.map((k) => ({ id: k.id, ...(k.milestone ? { milestone: k.milestone } : {}), status: k.status })) } : {}),
      tasks: tasks.map((t) => ({
        id: t.id,
        ref: t.ref,
        title: t.title,
        status: t.status,
        body: t.body.trim(),
        ...(t.record?.trim() ? { record: t.record.trim() } : {}),
        outputs: [...t.outputs, ...(t.repoOutputs ?? []).map((o) => `${o.repo}: ${o.output}`)],
      })),
    });
    const parent = r.parent ? ws.requests.get(r.parent) : undefined;
    if (parent && !memberIds.has(parent.id)) addContext({ id: parent.id, title: parent.title, status: parent.status, milestone: parent.milestone, relation: "parent", of: r.id });
    for (const k of kids) {
      if (!memberIds.has(k.id)) addContext({ id: k.id, title: k.title, status: k.status, milestone: k.milestone, relation: "child", of: r.id });
    }
  }
  if (!members.length) warnings.push({ code: "no_requests", target: mid, message: `マイルストーン ${mid} に属する要望がありません（判断材料が無いことを記録します）` });

  const milestone = {
    id: mid,
    title: m?.title ?? mid,
    ...(m?.due ? { due: m.due } : {}),
    ...(m?.done ? { done: true } : {}),
    known: !!m,
    ...(m?.purpose ? { purpose: m.purpose } : {}),
    ...(m?.goals?.length ? { goals: m.goals.map((g) => ({ id: g.id, text: g.text })) } : {}),
  };
  const units = reviewUnits(m);
  // 品質基準（版つき）。未設定・読めないは警告にして、設定や改善の要望へ案内する
  const quality = qualitySnapshot(ws.project.quality, ws.project.qualityVersion);
  if (quality.state === "unset") warnings.push({ code: "quality_unset", target: "project.yaml", message: "プロジェクトの品質基準は未設定です（品質は評価しません。p3 quality で設定するか、設定する要望を登録できます）" });
  if (quality.state === "invalid") warnings.push({ code: "quality_invalid", target: "project.yaml", message: `プロジェクトの品質基準が読めません（品質は評価しません。project.yaml を直してください）: ${(quality.problems ?? []).join(" / ")}` });
  const body = { milestone, units, requests, context, warnings, scope: REVIEW_SCOPE_RECORDS_ONLY, quality };
  return { ...body, extractedAt, extractedUntil: new Date().toISOString(), hash: reviewInputHash(body) };
}

/** 材料の識別子（抽出の日時・警告の文言は含めない） */
export function reviewInputHash(i: Pick<ReviewInput, "milestone" | "units" | "requests" | "context" | "warnings" | "code" | "quality">): string {
  const key = {
    milestone: [i.milestone.id, i.milestone.title, i.milestone.known, i.milestone.purpose ?? null, (i.milestone.goals ?? []).map((g) => [g.id, g.text])],
    requests: i.requests,
    context: i.context.map((c) => [c.id, c.status, c.milestone ?? null, c.relation, c.of]),
    missing: i.warnings.filter((w) => w.code === "broken_request" || w.code === "broken_task").map((w) => w.target),
    // 読んだコード（HEAD・ブランチ・未コミットの変更の中身・コミットが見つかるか）が変われば材料が変わった
    ...(i.code
      ? { code: i.code.map((c) => [c.name, c.status, c.head ?? null, c.branch ?? null, c.dirty ?? 0, c.dirtyDigest ?? null, c.commits.map((x) => [x.sha, x.from, x.found])]) }
      : {}),
    // 品質基準（状態と版。変われば材料が変わった）
    ...(i.quality ? { quality: [i.quality.state, i.quality.version] } : {}),
  };
  return createHash("sha256").update(JSON.stringify(key)).digest("hex");
}
