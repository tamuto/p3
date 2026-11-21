import { ANSWER_STATE_LABEL, criteriaSourceView, requestRequirementView, SOURCE_STATE_LABEL, type RequestRequirementView, type SourceConfirmation, type SourceView } from "../features/requirements/shared/requirementSource.ts";
import { absRef, parseRef } from "../shared/refs.ts";
import type { Request, Task } from "../shared/types.ts";
import { acceptanceStatus, basisDetail, basisLabel, EVIDENCE_BASIS_KINDS, EVIDENCE_BASIS_LABEL, evidenceBasisOf, type AcceptanceEvidence, type CriterionState } from "../features/requirements/shared/acceptance.ts";
import { blockWarnings } from "../shared/taskBlock.ts";
import { REWORK_CAUSE_LABEL, reworkLine } from "../features/records/shared/reworkHistory.ts";
import { COMPLETION_TRIGGER_LABEL, REF_CAPTURE_LABEL, type RefCapture } from "../features/records/shared/completionRecord.ts";
import type { P3Context } from "../core/context.ts";
import { table } from "./format.ts";
import { taskWork } from "../core/workTargets.ts";
import { requestWorkstreams } from "../shared/workTarget.ts";
import type { hierarchyView } from "../core/hierarchy.ts";

/**
 * show の短い出力（--brief）と、通常の出力と共通の項目。
 *
 * 短い出力は、AI がタスクを進めるのに要るものだけにする（本文は切り詰めない）:
 *   タスク: id・ref・request・title・status・body・rev・outputs・repoOutputs・依存（relations の depends_on）・受け入れ基準と証拠
 *          + work（作業先とそのブランチ）・dependencies（依存の相手と状態）・acceptance（基準があるときだけ）
 *   要望:   id・title・status・body・rev・workstreams + branches（作業先ごとのブランチ）+
 *          タスクの一覧（id・ref・title・status・repo）・issue + 親子（parent・ancestors・children・hierarchyIssues）
 * 省くもの: 日時・areas・labels・変更者・ファイルのパス・依存以外の関係・関係しそう（暗黙の近さ）・影響範囲。
 * JSON の項目名と階層は通常の --json と同じで、項目を省くだけ（短い出力だけの別名は作らない）。
 */

/** 依存の相手とその状態。相手が見つからない（アーカイブした・参照の誤り）ときは title・status が null（完了とは扱わない） */
export interface DependencyState {
  ref: string;
  title: string | null;
  status: string | null;
}

export function dependencyStates(ctx: P3Context, task: Task): DependencyState[] {
  return task.relations
    .filter((r) => r.type === "depends_on")
    .map((r) => {
      const ref = absRef(r.target, task.request) ?? r.target;
      const p = parseRef(ref);
      const target = p?.task ? ctx.ws.task(ref) : ctx.ws.requests.get(ref);
      return { ref, title: target?.title ?? null, status: target?.status ?? null };
    });
}

/** タスクの詳細で共通に出す項目（通常・短い出力の両方） */
export function taskExtras(ctx: P3Context, task: Task) {
  return { dependencies: dependencyStates(ctx, task) };
}

const BRIEF_TASK_KEYS = ["id", "ref", "request", "title", "status", "body", "rev", "outputs", "relations"] as const;

const STATE_MARK: Record<CriterionState, string> = { met: "✓ 満たした", unmet: "✗ 満たせなかった", unverified: "? 未検証", missing: "・ 証拠なし", stale: "! 再確認が必要（基準を変えた後）" };

/** 停止の行（show・brief・アーカイブで共通。履歴は通常の show だけ）。停止も履歴も問題も無ければ空 */
export function formatBlock(task: Pick<Task, "status" | "block" | "blockHistory" | "blockProblems">, { history = false } = {}): string[] {
  const lines: string[] = [];
  const b = task.block;
  if (b) {
    lines.push(`⏸ 止まっています（${b.since} から${b.updatedBy ? `・${b.updatedBy}` : ""}）`, ...b.reason.split("\n").map((l) => `  ${l}`));
    if (b.decision) lines.push("  決めてほしいこと:", ...b.decision.split("\n").map((l) => `    ${l}`));
  }
  for (const w of blockWarnings(task)) lines.push(`※ ${w}`);
  if (history && task.blockHistory?.length) {
    lines.push("停止の履歴:");
    const label = { set: "付けた", update: "直した", clear: "解除した" } as const;
    for (const h of task.blockHistory) {
      lines.push(`  ${h.at}  ${label[h.action]}${h.by ? `  ${h.by}` : ""}`);
      const shown = h.after ?? h.before;
      if (shown) lines.push(`    理由: ${shown.reason.split("\n")[0]}`);
      if (h.resolution) lines.push(`    回答・解決: ${h.resolution.split("\n").join(" / ")}`);
    }
  }
  return lines;
}

/**
 * 受け入れ基準と証拠・不足の行（show・criteria で共通）。基準が無いタスクは「受け入れ基準なし」の1行（emptyLine: false なら出さない）。
 * 証拠は作業した側の申告で、人が「済み」にする前に読むもの
 */
export function formatAcceptance(task: Task, { emptyLine = true } = {}): string[] {
  const acc = acceptanceStatus(task);
  if (!acc) return emptyLine ? ["受け入れ基準なし"] : [];
  const kinds = EVIDENCE_BASIS_KINDS.filter((k) => acc.metByBasis[k] > 0).map((k) => `${EVIDENCE_BASIS_LABEL[k]} ${acc.metByBasis[k]}`);
  const lines = [`受け入れ基準（${acc.met}/${acc.total} を満たしたと申告${kinds.length ? `。根拠: ${kinds.join("・")}` : ""}）:`];
  // 根拠の行: 結果と別に、種類（古い証拠は「種類未記録」）と、読んだもの・検査のコマンド・結果・対象
  const basisLines = (e: AcceptanceEvidence) => [`      根拠: ${basisLabel(e)}`, ...basisDetail(evidenceBasisOf(e).basis).map((d) => `        ${d.label}: ${d.value.split("\n").join("\n          ")}`)];
  // 要求の出典と確認（実装後の証拠とは別。要望者の申告の記録）
  const sv = task.acceptanceSources?.length ? criteriaSourceView(task.acceptanceCriteria, task.acceptanceSources) : undefined;
  const sourceLine = (id: string) => {
    const it = sv?.items.find((x) => x.id === id);
    if (!it || !it.sources.length) return [];
    return [`      出典と確認: ${SOURCE_STATE_LABEL[it.state]}（${it.sources.map((x) => `${x.id}${x.source ? ` ${x.source}` : ""}${x.confirmed ? ` ${x.confirmed.by}・${x.confirmed.on}` : ""}`).join(" / ")}）`];
  };
  for (const i of acc.items) {
    lines.push(`  ${i.id}  ${i.text}`, `      ${STATE_MARK[i.state]}`, ...sourceLine(i.id));
    if (i.evidence) lines.push(...basisLines(i.evidence));
    if (i.evidence?.evidence) lines.push(...i.evidence.evidence.split("\n").map((l) => `      ${l}`));
    if (i.state === "stale" && i.evidence) lines.push(`      （記録したときの基準: ${i.evidence.criterionText}）`);
  }
  for (const e of acc.orphans)
    lines.push(`  ${e.criterionId}  （基準は消されています: ${e.criterionText}）`, `      ${STATE_MARK[e.result]}`, ...basisLines(e), ...(e.evidence ? e.evidence.split("\n").map((l) => `      ${l}`) : []));
  for (const x of sv?.orphans ?? []) lines.push(`  ${x.criterionId}  （基準が無い出典と確認の記録 ${x.id}: 対応先不明）`);
  if (acc.shortfalls.length) lines.push("不足:", ...acc.shortfalls.map((s) => `  - ${s}`));
  return lines;
}

export function briefTask(ctx: P3Context, task: Task) {
  const item = Object.fromEntries(BRIEF_TASK_KEYS.map((k) => [k, task[k]])) as unknown as Pick<Task, (typeof BRIEF_TASK_KEYS)[number]> & Pick<Task, "repoOutputs" | "record" | "acceptanceCriteria" | "acceptanceEvidence" | "acceptanceSources" | "acceptanceProblems" | "block" | "blockProblems">;
  item.relations = task.relations.filter((r) => r.type === "depends_on");
  if (task.repoOutputs?.length) item.repoOutputs = task.repoOutputs;
  // 変更の記録（完了したタスク）。経緯を知るために読む
  if (task.record) item.record = task.record;
  // 受け入れ基準と証拠（着手時に読み、完了時に項目ごとの証拠を残す）
  if (task.acceptanceCriteria?.length) item.acceptanceCriteria = task.acceptanceCriteria;
  if (task.acceptanceEvidence?.length) item.acceptanceEvidence = task.acceptanceEvidence;
  // 基準ごとの要求の出典と確認（あるときだけ）
  if (task.acceptanceSources?.length) item.acceptanceSources = task.acceptanceSources;
  if (task.acceptanceProblems?.length) item.acceptanceProblems = task.acceptanceProblems;
  // 停止の今の値と読み取りの問題（履歴は省く）
  if (task.block) item.block = task.block;
  if (task.blockProblems?.length) item.blockProblems = task.blockProblems;
  // 着手先: 作業先のリポジトリとそのブランチ（作業先なしは repo: null）
  // 基準・証拠の状態（基準なしのタスクでは省く）
  const acceptance = acceptanceStatus(task);
  const completion = completionBrief(task);
  return { item, work: taskWork(ctx.ws, task), ...taskExtras(ctx, task), ...(acceptance ? { acceptance } : {}), ...(completion ? { completion } : {}) };
}

/** 完了の記録の概要（契機・日時・主体・rev。条件の写しは p3 show（--brief でない）か API の詳細で読む）。記録も問題も無ければ省く */
export function completionBrief(x: Pick<Task, "completionRecords" | "completionProblems">) {
  if (!x.completionRecords?.length && !x.completionProblems?.length) return undefined;
  return {
    records: (x.completionRecords ?? []).map((r) => ({ id: r.id, trigger: r.trigger, at: r.at, ...(r.by ? { by: r.by } : {}), rev: r.rev, status: r.status })),
    ...(x.completionProblems?.length ? { problems: x.completionProblems } : {}),
  };
}

const refLine = (r: RefCapture) =>
  r.state === "ok"
    ? `${r.name}: ${r.commit?.slice(0, 12) ?? ""}${r.dirty === true ? "（未コミットの変更あり）" : r.dirty === false ? "" : `（未コミットの変更は不明${r.reason ? `: ${r.reason}` : ""}）`}`
    : `${r.name}: ${r.reason ?? REF_CAPTURE_LABEL[r.state]}`;

/** 完了の記録の詳細（p3 show。そのときの条件の写しで、今の値とは別） */
export function formatCompletionDetail(x: Pick<Task, "completionRecords" | "completionProblems">): string[] {
  const lines = ["完了の記録（そのときの条件の写し。今の値とは別）:"];
  for (const r of x.completionRecords ?? []) {
    lines.push(`  ${r.id}  ${COMPLETION_TRIGGER_LABEL[r.trigger]}  ${r.at}  ${r.by ?? "（主体なし）"}  rev ${r.rev}  ${r.status}${r.checked ? "  済み" : ""}`);
    const q = r.quality;
    lines.push(`      品質: ${q.state === "set" ? "設定済" : q.state === "unset" ? "未設定" : "読めない"}  版 ${q.version}${q.standards ? `  項目 ${q.standards.map((s) => `${s.id}${s.exempt ? "（除外）" : ""}`).join(", ") || "なし"}` : ""}`);
    if (r.acceptance?.problems) lines.push(`      受け入れ基準: 読めない（${r.acceptance.problems.join(" / ")}）`);
    for (const c of r.acceptance?.criteria ?? []) {
      const e = r.acceptance?.evidence?.find((v) => v.criterionId === c.id);
      lines.push(`      ${c.id} ${c.text}${e ? `  → ${e.result}・${basisLabel(e)}` : "  → 証拠なし"}`);
    }
    if (r.title !== undefined) lines.push(`      題: ${r.title}`);
    if (r.requirement?.problems) lines.push(`      要求の根拠: 読めない（${r.requirement.problems.join(" / ")}）`);
    else if (r.requirement?.sources?.length) lines.push(`      要求の根拠: ${r.requirement.sources.map((s) => s.id).join(", ")}`);
    if (r.tasks) lines.push(`      タスク: ${r.tasks.map((t) => `${t.id} rev ${t.rev} ${t.status}${t.record ? ` ${t.record}` : "（記録なし）"}`).join(" / ") || "なし"}`);
    if (r.children?.length) lines.push(`      子の要望: ${r.children.map((t) => `${t.id} rev ${t.rev} ${t.status}${t.record ? ` ${t.record}` : "（記録なし）"}`).join(" / ")}`);
    lines.push(`      参照先: ${r.refs ? r.refs.map(refLine).join(" / ") || "登録なし" : "取得していません"}`);
  }
  for (const p of x.completionProblems ?? []) lines.push(`  ※読めない: ${p}（ファイルの completionRecords を直すまで新しい記録は足しません）`);
  return lines;
}

/** 手戻りの履歴（済みの解除・完了からの再開）の行 */
export function formatRework(t: Pick<Task, "reworkHistory" | "reworkProblems">): string[] {
  return [
    "手戻りの履歴（済みの解除・完了からの再開）:",
    ...(t.reworkHistory ?? []).map((e) => `  ${reworkLine(e)}  ${REWORK_CAUSE_LABEL[e.cause]}  ${e.at}  ${e.by ?? "（主体なし）"}  rev ${e.rev}`),
    ...(t.reworkProblems ?? []).map((p) => `  ※読めない: ${p}（ファイルの reworkHistory を直すまで新しい履歴は足しません）`),
  ];
}

/** 完了の記録の行（今の値とは別の、そのときの記録） */
export function formatCompletion(c: NonNullable<ReturnType<typeof completionBrief>>): string[] {
  return [
    "完了の記録（そのときの条件の写し。今の値とは別）:",
    ...c.records.map((r) => `  ${r.id}  ${COMPLETION_TRIGGER_LABEL[r.trigger]}  ${r.at}  ${r.by ?? "（主体なし）"}  rev ${r.rev}`),
    ...(c.problems ?? []).map((p) => `  ※読めない: ${p}（ファイルの completionRecords を直すまで新しい記録は足しません）`),
  ];
}

export function formatBriefTask(view: ReturnType<typeof briefTask>): string {
  const { item, work, dependencies } = view;
  const short = (ref: string) => (ref.startsWith(`${item.request}/`) ? ref.slice(item.request.length + 1) : ref);
  const lines = [`${item.ref}  ${item.title}`, `  status  ${item.status}  rev ${item.rev}`];
  lines.push(...formatBlock(item));
  lines.push(
    `  作業先  ${work.repo ? `${work.repo}${work.branch ? `  branch ${work.branch}` : "（ブランチなし）"}${work.registered ? "" : `  ※このマシンのパスが未登録（p3 repo path ${work.repo} <パス>）`}` : "なし"}`,
  );
  if (dependencies.length) {
    lines.push(`  依存    ${dependencies.map((d) => `${short(d.ref)} ${d.status ?? "（状態不明）"}`).join(" / ")}`);
  }
  for (const o of item.outputs) lines.push(`  成果物  ${o}`);
  for (const o of item.repoOutputs ?? []) lines.push(`  成果物  ${o.repo}: ${o.output}`);
  if (item.body.trim()) lines.push("", item.body.trim());
  if (item.record) lines.push("", "## 変更の記録", item.record);
  lines.push("", ...formatAcceptance(item as Task));
  if (view.completion) lines.push("", ...formatCompletion(view.completion));
  return lines.join("\n");
}

export function briefRequest(ctx: P3Context, r: Request, issue: string | undefined) {
  const item: Pick<Request, "id" | "title" | "status" | "parent" | "body" | "rev" | "workstreams"> = {
    id: r.id,
    title: r.title,
    status: r.status,
    ...(r.parent ? { parent: r.parent } : {}),
    body: r.body,
    rev: r.rev,
    ...(r.workstreams ? { workstreams: r.workstreams } : {}),
  };
  const branches = requestWorkstreams(r);
  const tasks = ctx.ws
    .tasksOf(r.id)
    .list()
    .map((t) => ({ id: t.id, ref: t.ref, title: t.title, status: t.status, repo: t.repo, ...(t.block ? { blocked: true } : {}) }));
  // 要求の出典と確認（記録・回答・読めない値があるときだけ）
  const req = requestRequirementView(r);
  const requirement = req.sources.length || req.answers.length || req.problems.length ? req : undefined;
  const completion = completionBrief(r);
  return { item, branches, tasks, ...(issue ? { issue } : {}), ...(requirement ? { requirement } : {}), ...(completion ? { completion } : {}) };
}

const confirmLine = (c: SourceConfirmation) => `${c.by}・${c.on}`;

export function sourceLines(s: SourceView, pad = "  "): string[] {
  return [
    `${pad}${s.id}  [${SOURCE_STATE_LABEL[s.state]}${s.confirmed ? `: ${confirmLine(s.confirmed)}` : ""}]${s.from ? `  （要望の ${s.from} を写したもの）` : ""}`,
    ...(s.target ? [`${pad}  対象: ${s.target}`] : []),
    ...(s.source ? [`${pad}  出典: ${s.source}`] : []),
    ...(s.basis ? [`${pad}  根拠: ${s.basis.split("\n").join(`\n${pad}        `)}`] : []),
    ...(s.history?.length ? [`${pad}  前の確認: ${s.history.map((h) => `${confirmLine(h)}${h.lapsedAt ? `（${h.lapsedAt.slice(0, 10)} に効かなくなった）` : ""}`).join(" / ")}`] : []),
  ];
}

/** 要望の根拠と回答（p3 source・p3 show で使う） */
export function formatRequirement(v: RequestRequirementView): string[] {
  const lines = [`要求の出典と確認: ${SOURCE_STATE_LABEL[v.state]}（申告の記録。P3 の保証ではありません）`];
  if (!v.sources.length) lines.push("  記録なし（任意。p3 source add --source <出典> --grounds <根拠> で残せます）");
  for (const s of v.sources) lines.push(...sourceLines(s));
  if (v.answers.length) {
    lines.push("確認事項への回答:");
    for (const a of v.answers) lines.push(`  ${a.run}/${a.question}  [${ANSWER_STATE_LABEL[a.state]}]  ${a.copy.question}`, `    回答${a.by || a.on ? `（${[a.by, a.on].filter(Boolean).join("・")}）` : ""}: ${a.answer.split("\n").join("\n          ")}`);
  }
  for (const p of v.problems) lines.push(`  ※読めない: ${p}（request.md を直してください）`);
  return lines;
}

/** 親子の行（祖先と直下の子。無ければ何も出さない） */
export function formatFamily(f: Awaited<ReturnType<typeof hierarchyView>>): string[] {
  return [
    ...(f.ancestors.length ? [`  親      ${f.ancestors.map((a) => `${a.id} ${a.title}`).join(" > ")}`] : []),
    ...(f.children.length
      ? ["", `子の要望 (${f.children.length}、表示順。実行の順ではない):`, table(f.children.map((c) => [`  ${c.id}`, c.status, `${c.tasks.done}/${c.tasks.total}`, c.title]))]
      : []),
  ];
}

export function formatBriefRequest(view: ReturnType<typeof briefRequest> & Partial<Awaited<ReturnType<typeof hierarchyView>>>): string {
  const { item, branches, tasks, issue } = view;
  const family = view.ancestors && view.children && view.hierarchyIssues ? (view as Awaited<ReturnType<typeof hierarchyView>>) : undefined;
  const names = Object.keys(branches);
  // ブランチは作業先ごと
  const branchLine = "";
  return [
    issue ? `※ ${issue}` : "",
    ...(family?.hierarchyIssues.map((i) => `※ ${i.message}`) ?? []),
    `${item.id}  ${item.title}`,
    `  status  ${item.status}  rev ${item.rev}${branchLine}`,
    ...(branchLine ? [] : names.map((n) => `  branch  ${n}: ${branches[n].branch}`)),
    ...(family ? formatFamily(family) : []),
    item.body.trim() ? `\n${item.body.trim()}` : "",
    ...(view.requirement ? ["", ...formatRequirement(view.requirement)] : []),
    ...(view.completion ? ["", ...formatCompletion(view.completion)] : []),
    "",
    `タスク (${tasks.length}):`,
    table(tasks.map((t) => [`  ${t.id}`, t.status, t.repo ?? "（作業先なし）", `${t.title}${t.blocked ? "  ⏸停止" : ""}`])) || "  （なし）",
  ]
    .filter((l, i) => l !== "" || i > 1)
    .join("\n");
}
