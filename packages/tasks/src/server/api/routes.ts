import { apiError } from "../../core/errorOutcome.ts";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { normalizeTaskId } from "../../shared/refs.ts";
import { REQUEST_STATUSES, type Request, type ServerEvent, type Task, TASK_STATUSES, type AttachmentFormat } from "../../shared/types.ts";
import type { P3Context } from "../../core/context.ts";
import { listTasks, progress, resolve } from "../../core/ops.ts";
import { ConflictError, NotFoundError } from "../../core/store/collection.ts";
import { ACCEPTANCE_RESULTS, acceptanceStatus, type EvidenceBasis } from "../../features/requirements/shared/acceptance.ts";
import { requestRequirementView, type CriterionSource, type SourceOp } from "../../features/requirements/shared/requirementSource.ts";
import { MILESTONE_REVIEW_SECTIONS, RISK_STATES, TASK_REVIEW_SECTIONS } from "../../features/retro/shared/retrospective.ts";
import { confirmRetrospectiveTarget, judgeRisk, retrospectiveView } from "../../features/retro/core/retrospective.ts";
import { metricsRoutes } from "../../features/metrics/server/metricsRoutes.ts";
import { requestReview, reviewCandidates, taskReview } from "../../features/records/core/reviewCandidates.ts";
import { taskQualityDiff, type QualityOp } from "../../features/quality/shared/quality.ts";
import { qualityTemplate, qualityView, updateQuality } from "../../features/quality/core/quality.ts";
import { diagnoseQuality, improvementDraft, registerImprovement } from "../../features/quality/core/qualityImprovement.ts";
import { ATTACHMENT_LIMITS, ATTACHMENT_TYPES, AttachmentError, safeFileName } from "../../core/store/attachments.ts";
import { bodyLimit } from "hono/body-limit";
import { getArchivedTask, listArchivedTasks } from "../../core/store/archivedTasks.ts";
import { completionCheckOf, hierarchyNow, resolvedIssue } from "../../core/requestStatus.ts";
import { hierarchyView } from "../../core/hierarchy.ts";
import { supersededMarks } from "../../core/supersede.ts";
import { chatgptRoutes } from "./chatgptRoutes.ts";
import { userThemeRoutes, userThemeScriptRoute } from "../../features/settings/server/userThemeRoutes.ts";
import { AI_MANIFEST } from "./manifest.ts";
import { repoRoutes } from "../../features/settings/server/repoRoutes.ts";
import { releaseNoteRoutes } from "./releaseNoteRoutes.ts";
import { milestoneReviewRoutes } from "./milestoneReviewRoutes.ts";
import { taskReviewRoutes } from "./taskReviewRoutes.ts";
import { archiveTask, checkMilestoneRemoval, createRequest, createTask, orderChildren, updateRequest, updateTask, importQuality, saveClarifyAnswer, updateRequirement, recordPremise } from "../../core/requestOps.ts";
import { PREFLIGHT_RUNNERS, type PreflightRunner } from "../../shared/preflightRunner.ts";
import { CancelRefusedError, PulseInputError } from "../../core/preflight/service.ts";

/**
 * ブラウザ用のローカル API。AI や人の操作は CLI（ファイルを直接読み書き）が主で、ここは画面のため。
 *
 *   /requests                              要望（進捗つき）
 *   /requests/:rid                         要望の詳細
 *   /requests/:rid/tasks[/:tid]            要望のタスク
 *   /requests/:rid/archived-tasks[/:tid]   アーカイブしたタスク（読むだけ）
 *   /requests/:rid/preflight[/:run]        Preflight
 *   /requests/:rid/notes                   Preflight へのメモ
 *   /release-notes[/:mid]                  マイルストーンのリリースノート（releaseNoteRoutes.ts）
 *   /metrics[?milestone=<ID>]              開発の指標（features/metrics。読むだけ）
 *   /milestones/:mid/review[s...]          マイルストーンレビュー（milestoneReviewRoutes.ts）
 *   /requests/:rid/tasks/:tid/review[s...] タスクの AI レビュー（taskReviewRoutes.ts）
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const taskInput = z.object({
  title: z.string().min(1),
  /** 作業先（参照先の名前）。null は作業先なし */
  repo: z.string().nullable().optional(),
  repoOutputs: z.array(z.object({ repo: z.string().min(1), output: z.string().min(1) })).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  labels: z.array(z.string()).optional(),
  areas: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  body: z.string().optional(),
  /** 変更の記録（Markdown。完了にするときに書く） */
  record: z.string().nullable().optional(),
});
/** 受け入れ基準・証拠への操作（規則は shared/acceptance.ts。CLI の criteria / evidence と同じ） */
const acceptanceOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), text: z.string() }),
  z.object({ op: z.literal("edit"), id: z.string(), text: z.string() }),
  z.object({ op: z.literal("remove"), id: z.string() }),
  z.object({ op: z.literal("order"), ids: z.array(z.string()) }),
  // basis（根拠）の形と組み合わせは shared/acceptance.ts の cleanBasis・basisMismatch が確かめる（規則を2か所に書かない）
  z.object({ op: z.literal("record"), id: z.string(), result: z.enum(ACCEPTANCE_RESULTS), evidence: z.string().default(""), basis: z.custom<EvidenceBasis>((v) => v !== null && typeof v === "object").optional() }),
  z.object({ op: z.literal("unrecord"), id: z.string() }),
  // 基準ごとの要求の根拠（出典・確認）。操作の形と規則は shared/requirementSource.ts の applySourceOps が確かめる
  z.object({ op: z.literal("source"), id: z.string(), source: z.custom<SourceOp>((v) => v !== null && typeof v === "object") }),
]);
/** 品質基準の操作（規則は shared/quality.ts。CLI の p3 quality と同じ） */
const qualityCheck = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("machine"), command: z.string(), success: z.string() }),
  z.object({ kind: z.literal("manual"), reference: z.string() }),
]);
const qualityInput = z.object({ text: z.string(), repos: z.array(z.string()).optional(), check: qualityCheck });
const qualityOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("init") }),
  z.object({ op: z.literal("adopt"), template: z.string(), version: z.number().int().optional() }),
  z.object({ op: z.literal("upgrade"), template: z.string() }),
  z.object({ op: z.literal("add"), standard: qualityInput }),
  z.object({
    op: z.literal("replace"),
    standards: z.array(qualityInput.extend({ id: z.string().optional(), exemptReason: z.string().optional(), source: z.object({ template: z.string(), version: z.number().int(), key: z.string() }).optional() })).max(200),
    templates: z.array(z.object({ id: z.string(), version: z.number().int() })).optional(),
  }),
  z.object({ op: z.literal("edit"), id: z.string(), standard: qualityInput.partial() }),
  z.object({ op: z.literal("remove"), id: z.string() }),
  z.object({ op: z.literal("exempt"), id: z.string(), reason: z.string() }),
  z.object({ op: z.literal("unexempt"), id: z.string() }),
]);
/** 作るとき: 受け入れ基準は文の並び（ID は p3 が振る） */
const taskCreate = taskInput.extend({ criteria: z.array(z.string()).optional(), quality: z.union([z.enum(["auto", "none"]), z.array(z.string())]).optional() });
/** checked: 完了したタスクに人が「済み」を付ける / 外す。acceptance: 基準・証拠への操作（順に当て、1つでも合わなければ何も書かない） */
/** 停止の操作（規則は shared/taskBlock.ts。CLI の block / unblock と同じ。日時・履歴は受け付けない） */
const blockOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), reason: z.string(), decision: z.string().optional() }),
  z.object({ op: z.literal("clear"), resolution: z.string() }),
]);
const taskPatch = taskInput
  .partial()
  .extend({ rev: z.number().int().optional(), checked: z.boolean().optional(), acceptance: z.array(acceptanceOp).optional(), blockOp: blockOp.optional() });
const requestInput = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  areas: z.array(z.string()).optional(),
  due: date.nullish(),
  milestone: z.string().nullish(),
  tags: z.array(z.string()).optional(),
  /** 親の要望 ID（子の要望にする。PATCH の null は親を外す） */
  parent: z.string().nullish(),
});
const requestPatch = requestInput
  .partial()
  .extend({ status: z.enum(REQUEST_STATUSES as [string, ...string[]]).optional(), rev: z.number().int().optional() });
/** 子の表示順: 直下の子の ID を全部、上から順に */
const childOrderInput = z.object({ children: z.array(z.string().min(1)), rev: z.number().int().optional() });
const projectPatch = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    milestones: z.array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9._-]+$/, "マイルストーンの id は英数字と . _ -"),
        title: z.string().min(1),
        due: date.optional(),
        done: z.boolean().optional(),
        // 目的・予定機能（キーを省くと今の値を残す。null・空で消す）。件数・文字数・空・重複の規則は保存の側（shared/milestoneGoals.ts）
        purpose: z.string().nullish().transform((v) => (v === null ? "" : v)),
        goals: z
          .array(z.object({ id: z.string(), text: z.string() }))
          .nullish()
          .transform((v) => (v === null ? [] : v)),
      }),
    ),
    branchPattern: z.string().includes("{id}"),
    // 担当（runner）は省ける（以前の形 { instructions } の更新でも、保存は項目ごとに重ねるので担当は残る）
    preflight: z.object({ instructions: z.string().optional(), runner: z.enum(PREFLIGHT_RUNNERS as [PreflightRunner, ...PreflightRunner[]]).optional() }),
    /** 編集を始めたときのマイルストーンの版（GET /api/project の milestonesVersion）。違えば 409 milestones_conflict */
    milestonesVersion: z.string(),
  })
  .partial()
  .superRefine((p, ctx) => {
    for (const [label, ids] of [["マイルストーン", p.milestones?.map((x) => x.id) ?? []]] as const) {
      const dup = ids.find((x, i) => ids.indexOf(x) !== i);
      if (dup) ctx.addIssue({ code: "custom", message: `${label}の id が重複しています: ${dup}` });
    }
  });

/** null は「項目を消す」意味。frontmatter から外すため undefined に変換 */
const unnull = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? undefined : v])) as {
    [K in keyof T]: Exclude<T[K], null>;
  };

/** 誰が変更したか */
const actorOf = (c: Context) => c.req.header("x-p3-actor") ?? "human:web";

/** 楽観ロック: body.rev か If-Match ヘッダ */
const expectedRev = (c: Context, body: { rev?: number }) => body.rev ?? (c.req.header("if-match") ? Number(c.req.header("if-match")) : undefined);

/** 原本を返す。xlsx は必ずダウンロードにし、画像も中身を推測させない */
function download(c: Context, data: Buffer, format: AttachmentFormat, name: string) {
  const file = safeFileName(name, format);
  return c.body(new Uint8Array(data), 200, {
    "Content-Type": ATTACHMENT_TYPES[format],
    "Content-Disposition": `${format === "xlsx" ? "attachment" : "inline"}; filename="${file.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Cache-Control": "private, no-cache",
  });
}

/**
 * notify: プロジェクトに属さない変更（ChatGPT の接続・テーマ）の知らせ方。省くとこのプロジェクトの画面へだけ流す
 * （プロジェクトを跨ぐ serve では開いている全プロジェクトへ）
 */
export function apiRoutes(ctx: P3Context, opts: { notify?: (kind: "user" | "chatgpt") => void } = {}) {
  const { ws, preflight } = ctx;
  const notify = opts.notify ?? ((kind: "user" | "chatgpt") => ws.emit({ type: "changed", kind }));
  const app = new Hono();

  // エラーの状態と code は core/errorOutcome.ts の表（CLI の終了コードと同じ所）。版の競合は今の値（要望・タスク）を添える
  app.onError((err, c) => {
    if (err instanceof ConflictError) {
      const current = err.id.includes("/") ? ws.task(err.id) : c.req.param("tid") ? ws.tasksOf(c.req.param("rid")!).get(err.id) : ws.requests.get(err.id);
      return c.json({ error: err.message, code: "rev_conflict", current }, 409);
    }
    if (err instanceof z.ZodError) return c.json({ error: "invalid input", issues: err.issues }, 400);
    const r = apiError(err);
    if (r) return c.json(r.body, r.status);
    console.error(err);
    return c.json({ error: err.message }, 400);
  });

  /** パスの要望 ID（存在しなければ 404） */
  const rid = (c: Context) => ws.requests.require(c.req.param("rid")!).id;
  /** パスのタスク ID（T3 / 3 も可） */
  const tid = (c: Context) => normalizeTaskId(c.req.param("tid")!) ?? c.req.param("tid")!;

  // --- meta ---------------------------------------------------------------
  app.get("/project", (c) =>
    c.json({
      project: ws.project,
      milestonesVersion: ws.milestonesVersion,
      dataDir: ws.dataDir,
      engines: preflight.availableEngines(),
      defaultEngine: preflight.defaultEngine,
      errors: ws.errors(),
    }),
  );
  app.put("/project", async (c) => {
    const { milestonesVersion, ...patch } = projectPatch.parse(await c.req.json());
    // 使っている要望・リリースノートのあるマイルストーンは消さない（CLI の milestone rm と同じ規則）
    if (patch.milestones) await checkMilestoneRemoval(ctx, patch.milestones.map((m) => m.id));
    const milestones = patch.milestones?.map((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as typeof m);
    return c.json(await ws.saveProject({ ...patch, ...(milestones ? { milestones } : {}) }, { milestonesVersion }));
  });
  app.get("/ai/manifest", (c) => c.json(AI_MANIFEST));
  /** 参照先（設定画面。このマシンのパスはローカルの画面からだけ） */
  app.route("/repos", repoRoutes(ctx));
  /** データのフォルダを全部読み直す（ファイル監視に頼らない取り込み）。終わったら変更通知 kind: "reload" */
  app.post("/reload", async (c) => c.json(await ws.reloadAll()));
  /** Preflight のエンジンが使えるか（Codex なら Docker・認証・イメージを確かめる） */
  app.get("/engine", async (c) => c.json(await preflight.engineStatus()));
  if (ctx.chatgpt) app.route("/chatgpt", chatgptRoutes(ctx.chatgpt, { changed: () => notify("chatgpt"), engine: () => preflight.engineStatus() }));
  /** 個人設定のテーマ（このマシンのすべてのプロジェクトで共通。ほかの個人設定は扱わない） */
  app.route("/user-theme", userThemeRoutes(() => notify("user")));
  /** 最初の描画の前に読むスクリプト（index.html の先頭）。テーマだけを埋め込み、キャッシュさせない */
  app.route("/user-theme.js", userThemeScriptRoute());

  /** マイルストーンのリリースノート（材料・保存・出力・要約の生成） */
  app.route("/", releaseNoteRoutes(ctx));
  app.route("/", milestoneReviewRoutes(ctx));
  app.route("/", taskReviewRoutes(ctx));

  // --- requests -------------------------------------------------------------
  app.get("/requests", (c) => {
    // ?parent=<ID>: 直下の子だけを、親の表示順（子の一覧・詳細と同じ）で。省くと更新の新しい順
    const parent = c.req.query("parent");
    const all = progress(ctx);
    if (parent === undefined) return c.json(all);
    const rows = new Map(all.map((p) => [p.request.id, p]));
    return c.json(hierarchyNow(ws).children(parent).flatMap((r) => rows.get(r.id) ?? []));
  });
  app.post("/requests", async (c) => {
    const b = unnull(requestInput.parse(await c.req.json()));
    return c.json(await createRequest(ctx, b, actorOf(c)), 201);
  });
  app.get("/requests/:rid", async (c) => {
    const id = rid(c);
    return c.json({
      request: ws.requests.get(id),
      // 要求の根拠の記録と回答の状態（shared/requirementSource.ts。申告の記録で、P3 の保証ではない）
      requirement: requestRequirementView(ws.requests.require(id)),
      tasks: ws.tasksOf(id).list(),
      runs: await Promise.all((await preflight.list(id)).map((r) => preflight.withInputMatch(id, r))),
      // 対応済なのに未完了のタスクがある（外部の直接編集など）
      issue: resolvedIssue(ws, ws.requests.require(id)) ?? null,
      // 親子（parent・ancestors・children・hierarchyIssues）と、対応済にできるか（blocker・見送りで対象外の子 excluded）
      ...(await hierarchyView(ws, id)),
      completion: completionCheckOf(ws, hierarchyNow(ws), id),
      // 見直しが必要（候補）: 要望自身（対応済・完了済）・タスクごとの概要・配下の件数（読むだけ。shared/reviewCandidate.ts）
      review: requestReview(ctx, id),
      // 置き換えられたタスクの印（T001 → 置き換えた側）
      superseded: Object.fromEntries(
        [...supersededMarks(ws)].filter(([ref]) => ref.startsWith(`${id}/`)).map(([ref, m]) => [ref.slice(id.length + 1), m]),
      ),
    });
  });
  app.patch("/requests/:rid", async (c) => {
    const { rev, ...patch } = requestPatch.parse(await c.req.json());
    return c.json(await updateRequest(ctx, rid(c), unnull(patch) as Partial<Request>, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) }));
  });

  /** 要望の要求の根拠の記録を変える（CLI の p3 source と同じ操作。順に当て、1つでも合わなければ何も書かない） */
  app.post("/requests/:rid/sources", async (c) => {
    const { ops, rev } = z.object({ ops: z.array(z.custom<SourceOp>((v) => v !== null && typeof v === "object")).min(1), rev: z.number().int().optional() }).parse(await c.req.json());
    const r = await updateRequirement(ctx, rid(c), ops, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) });
    return c.json({ request: r, requirement: requestRequirementView(r) });
  });
  /**
   * Preflight の確認事項に回答する（CLI の p3 answer と同じ）。answer: null で回答を消す。回答は要望に残し、過去の run は書き換えない。
   * 回答しただけでは根拠の記録を確認記録ありにしない。再評価は別に明示して始める
   */
  /**
   * 前提の変更（外部の規則の変更など）を記録する。add: {op: "add", targets, reason, condition} / ack: {op: "ack", id, target, condition}。
   * 過去の完了の記録・状態・済みは変えない。対象が無い・規則に合わなければ 400 premise_invalid、rev が違えば 409（何も書かない）
   */
  app.get("/requests/:rid/premises", (c) => c.json(ws.requests.require(rid(c)).premiseChanges ?? []));
  app.post("/requests/:rid/premises", async (c) => {
    const b = z
      .discriminatedUnion("op", [
        z.object({ op: z.literal("add"), targets: z.array(z.string()), reason: z.string(), condition: z.string(), rev: z.number().int().optional() }),
        z.object({ op: z.literal("ack"), id: z.string(), target: z.string(), condition: z.string(), rev: z.number().int().optional() }),
      ])
      .parse(await c.req.json());
    const { rev, ...op } = b;
    const r = await recordPremise(ctx, rid(c), op, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) });
    return c.json({ change: r.change, rev: r.request.rev });
  });
  /** 要望の振り返り: 確定した対象・訂正の履歴・候補（採用を終えた run と根拠）。読むだけ */
  app.get("/requests/:rid/retrospective", async (c) => c.json(await retrospectiveView(ctx, rid(c))));
  /** 振り返りの対象を確定する {run, reason?（2回目からの訂正で必須）, version?（読んだときの版）} */
  app.post("/requests/:rid/retrospective/target", async (c) => {
    const b = z.object({ run: z.string().min(1), reason: z.string().optional(), version: z.number().int().optional() }).parse(await c.req.json());
    return c.json(await confirmRetrospectiveTarget(ctx, rid(c), { run: b.run, reason: b.reason }, { expectedVersion: b.version, actor: actorOf(c) }));
  });
  /** リスクの確認を記録する {risk（0 から）, state, facts?, scope?, reason?, evidence: [根拠の指定], version?}（人の判断。追記） */
  app.post("/requests/:rid/retrospective/judgments", async (c) => {
    const ev = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("task_review"), task: z.string(), run: z.string(), section: z.enum(TASK_REVIEW_SECTIONS), index: z.number().int().optional() }),
      z.object({ kind: z.literal("milestone_review"), milestone: z.string(), run: z.string(), section: z.enum(MILESTONE_REVIEW_SECTIONS), index: z.number().int().optional(), reason: z.string().optional() }),
      z.object({ kind: z.literal("rework"), task: z.string(), history: z.string() }),
      z.object({ kind: z.literal("manual"), reference: z.string(), note: z.string().optional() }),
    ]);
    const b = z
      .object({ risk: z.number().int().min(0), state: z.enum(RISK_STATES), facts: z.string().optional(), scope: z.string().optional(), reason: z.string().optional(), evidence: z.array(ev).default([]), version: z.number().int().optional() })
      .parse(await c.req.json());
    const { version, ...input } = b;
    return c.json(await judgeRisk(ctx, rid(c), input, { expectedVersion: version, actor: actorOf(c) }));
  });
  /** 見直しが必要（候補）の一覧（完了したタスクと対応済・完了済の要望。完了済みも含む。?request= でその要望だけ） */
  app.route("/", metricsRoutes(ctx));
  app.get("/revisit", (c) => {
    const request = c.req.query("request");
    return c.json(reviewCandidates(ctx, request ? { request } : {}));
  });
  app.post("/requests/:rid/answers", async (c) => {
    const b = z
      .object({
        run: z.string(),
        question: z.string(),
        answer: z.string().nullable(),
        by: z.string().optional(),
        on: z.string().optional(),
        source: z.string().optional(),
        basis: z.string().optional(),
        links: z.array(z.string()).optional(),
        rev: z.number().int().optional(),
      })
      .parse(await c.req.json());
    const id = rid(c);
    const run = await preflight.get(id, b.run);
    if (!run) throw new NotFoundError(b.run);
    const q = run.assessment?.clarifications?.find((x) => x.id === b.question);
    if (!q) return c.json({ error: `${b.run} に確認事項 ${b.question} はありません`, code: "requirement_invalid" }, 400);
    const input = b.answer === null ? null : { answer: b.answer, by: b.by, on: b.on, source: b.source, basis: b.basis, links: b.links };
    const r = await saveClarifyAnswer(ctx, id, b.run, q, input, { expectedRev: expectedRev(c, b), actor: actorOf(c) });
    return c.json({ request: r.request, answer: r.answer ?? null, requirement: requestRequirementView(r.request) });
  });

  /** 子の表示順（直下の子を全部、上から順に。CLI の request order と同じ操作） */
  app.put("/requests/:rid/child-order", async (c) => {
    const { children, rev } = childOrderInput.parse(await c.req.json());
    const id = rid(c);
    const r = await orderChildren(ctx, id, children, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) });
    return c.json({ request: r, children: hierarchyNow(ws).children(id).map((k) => k.id) });
  });

  // --- 品質基準（project.yaml の quality。core/quality.ts） ----------------------------
  app.get("/quality", (c) => c.json(qualityView(ws)));
  app.get("/quality/templates/:id", (c) => {
    const v = c.req.query("version");
    const t = qualityTemplate(c.req.param("id"), v ? Number(v) : undefined);
    return t ? c.json(t) : c.json({ error: `テンプレートがありません: ${c.req.param("id")}`, code: "not_found" }, 404);
  });
  app.post("/quality", async (c) => {
    const { ops, version } = z.object({ ops: z.array(qualityOp).min(1).max(200), version: z.string().optional() }).parse(await c.req.json());
    return c.json(await updateQuality(ws, ops as QualityOp[], { expectedVersion: version }));
  });

  // --- 品質の改善要望（core/qualityImprovement.ts。診断と原稿は読むだけ、登録は明示したときだけ） ------------
  const improvementSource = z.discriminatedUnion("type", [
    z.object({ type: z.literal("project") }),
    z.object({ type: z.literal("task-review"), request: z.string(), task: z.string(), run: z.string() }),
    z.object({ type: z.literal("milestone-review"), milestone: z.string(), run: z.string() }),
  ]);
  app.post("/quality/improvements/preview", async (c) => {
    const { source, keys } = z.object({ source: improvementSource, keys: z.array(z.string()).optional() }).parse(await c.req.json());
    const d = await diagnoseQuality(ctx, source);
    const picked = keys ?? d.findings.filter((f) => f.suggested).map((f) => f.key);
    return c.json({ ...d, picked, ...(picked.length ? { draft: improvementDraft(d, picked) } : {}) });
  });
  app.post("/quality/improvements", async (c) => {
    const body = z
      .object({ source: improvementSource, keys: z.array(z.string()).min(1), title: z.string(), body: z.string(), hash: z.string(), reopenClosed: z.boolean().optional() })
      .parse(await c.req.json());
    return c.json(await registerImprovement(ctx, body, actorOf(c)), 201);
  });

  // --- tasks（要望の中） --------------------------------------------------------
  app.get("/requests/:rid/tasks", (c) => {
    const { status, area, q, blocked, review } = c.req.query();
    return c.json(listTasks(ctx, { request: rid(c), status: status?.split(","), area, q, blocked: blocked === "true", review: review === "true" }));
  });
  app.post("/requests/:rid/tasks", async (c) => {
    const raw = taskCreate.parse(await c.req.json());
    const { repo, ...b } = unnull(raw);
    // 作業先は null（作業先なし）を残す。書かなければ既定（requestOps.createTask）
    const input = { ...b, ...("repo" in raw ? { repo: raw.repo ?? null } : {}) } as Partial<Task> & { title: string };
    const { task, reopened, reopenedAncestors, warnings } = await createTask(ctx, rid(c), input, actorOf(c));
    return c.json({ ...task, ...(reopened ? { reopened } : {}), ...(reopenedAncestors ? { reopenedAncestors } : {}), ...(warnings.length ? { warnings } : {}) }, 201);
  });
  app.get("/requests/:rid/tasks/:tid", (c) => {
    const task = ws.tasksOf(rid(c)).require(tid(c));
    return c.json({ task, superseded: supersededMarks(ws).get(task.ref) ?? [], acceptance: acceptanceStatus(task) ?? null, review: taskReview(ctx, task) ?? null });
  });
  app.patch("/requests/:rid/tasks/:tid", async (c) => {
    const { rev, checked, acceptance, blockOp: bop, ...patch } = taskPatch.parse(await c.req.json());
    const next = {
      ...(bop ? { blockOp: bop } : {}),
      ...(unnull(patch) as Partial<Task>),
      ...("repo" in patch ? { repo: patch.repo ?? null } : {}),
      ...(checked !== undefined ? { checked } : {}),
      ...(acceptance?.length ? { acceptance } : {}),
    };
    // 置き換えられたタスクを作業中にしたら警告を添える（操作は続ける）。基準・証拠が変わって済みを外したら checkCleared
    // 完了の記録が壊れていて足せなかったら completionSkipped（状態は変えた）
    const { task, warnings, reopened, reopenedAncestors, checkCleared, completionSkipped, reworkSkipped } = await updateTask(ctx, rid(c), tid(c), next, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) });
    return c.json({
      ...task,
      ...(warnings.length ? { warnings } : {}),
      ...(reopened ? { reopened } : {}),
      ...(reopenedAncestors ? { reopenedAncestors } : {}),
      ...(checkCleared ? { checkCleared } : {}),
      ...(completionSkipped ? { completionSkipped } : {}),
      ...(reworkSkipped ? { reworkSkipped } : {}),
    });
  });
  /** 今の品質基準との差分（読むだけ。タスクは書き換えない） */
  app.get("/requests/:rid/tasks/:tid/quality-diff", (c) => {
    const task = ws.tasksOf(rid(c)).require(tid(c));
    return c.json({ quality: ws.project.quality?.state ?? "unset", version: ws.project.qualityVersion, diff: taskQualityDiff(task.acceptanceCriteria ?? [], ws.project.quality, task.repo) });
  });
  /** 差分を明示して取り込む（keys: "<kind>:<品質 ID>"。省くと「直した」以外の全部） */
  app.post("/requests/:rid/tasks/:tid/quality-import", async (c) => {
    const { keys, rev } = z.object({ keys: z.array(z.string()).optional(), rev: z.number().int().optional() }).parse(await c.req.json().catch(() => ({})));
    const r = await importQuality(ctx, rid(c), tid(c), keys, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) });
    return c.json({ ...r.task, applied: r.applied, ...(r.checkCleared ? { checkCleared: r.checkCleared } : {}) });
  });
  app.delete("/requests/:rid/tasks/:tid", async (c) => {
    await archiveTask(ctx, rid(c), tid(c));
    return c.json({ ok: true });
  });

  // --- アーカイブしたタスク（読むだけ。通常のタスクの道はアーカイブを探さない） ------------------------
  app.get("/requests/:rid/archived-tasks", async (c) => c.json(await listArchivedTasks(ws, c.req.param("rid"))));
  app.get("/requests/:rid/archived-tasks/:tid", async (c) => c.json({ task: await getArchivedTask(ws, c.req.param("rid"), tid(c)) }));

  // --- preflight ----------------------------------------------------------
  app.post("/requests/:rid/preflight", async (c) => {
    const body = z
      .object({ engine: z.enum(["codex", "mock"]).optional(), note: z.string().optional() })
      .parse(await c.req.json().catch(() => ({})));
    const id = rid(c);
    const actor = actorOf(c);
    // メモを書き足してから実行する。実行を始められなくてもメモは残し、その ID を返す（再試行で書き直さない）
    const note = body.note?.trim() ? await preflight.addNote(id, body.note, actor) : undefined;
    try {
      return c.json(await preflight.start(id, { engine: body.engine, actor }), 202);
    } catch (e) {
      if (!note) throw e;
      return c.json({ error: (e as Error).message, note }, 400);
    }
  });
  app.get("/requests/:rid/notes", async (c) => {
    const id = rid(c);
    const [{ notes, invalid }, carry] = await Promise.all([ws.notes.list(id), preflight.carryover(id)]);
    const pending = new Set(carry.notes.map((n) => n.id));
    return c.json({
      notes: notes.map((n) => ({ ...n, pending: pending.has(n.id) })),
      invalid,
      previous: carry.previous?.id ?? null,
      previousSkipped: carry.previousSkipped ?? null,
    });
  });
  app.post("/requests/:rid/notes", async (c) => {
    const { body } = z.object({ body: z.string() }).parse(await c.req.json());
    return c.json(await preflight.addNote(rid(c), body, actorOf(c)), 201);
  });
  // run ごとに、評価対象と今の要望が同じか（inputMatch）を添える
  app.get("/requests/:rid/preflight", async (c) => {
    const id = rid(c);
    return c.json(await Promise.all((await preflight.list(id)).map((r) => preflight.withInputMatch(id, r))));
  });
  // 最新の Preflight と見ている run の今の状態（ディスクから読むだけ。開いている要望の画面が軽く確かめる）。キャッシュの要望は使わない
  app.get("/requests/:rid/preflight-status", async (c) => {
    try {
      return c.json(await preflight.pulse(c.req.param("rid"), c.req.query("run")));
    } catch (e) {
      if (e instanceof PulseInputError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });
  app.get("/requests/:rid/preflight/:run", async (c) => {
    const id = rid(c);
    const run = await preflight.get(id, c.req.param("run"));
    if (!run) throw new NotFoundError(c.req.param("run"));
    return c.json(await preflight.withInputMatch(id, run));
  });
  // 画面資料の画像（PNG / JPEG）。要望 / run / 資料 ID で決め、パスは受け取らない。原稿（HTML）は配信しない
  app.get("/requests/:rid/preflight/:run/ui/:material", async (c) => {
    const { data, type } = await preflight.uiImage(rid(c), c.req.param("run"), c.req.param("material"));
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "private, max-age=3600",
    });
  });
  // 添付（画像・xlsx）。原本はダウンロードとして返す（画像も画面には ui の資料として出す）
  app.get("/requests/:rid/attachments", async (c) => c.json({ ...(await ws.attachments.list(rid(c))), limits: ATTACHMENT_LIMITS }));
  app.post("/requests/:rid/attachments", bodyLimit({ maxSize: ATTACHMENT_LIMITS.xlsxBytes + 1024 * 1024, onError: (c) => c.json({ error: "大きすぎます" }, 413) }), async (c) => {
    const id = rid(c);
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) return c.json({ error: "file（ファイル）を付けてください" }, 400);
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    try {
      const a = await preflight.addAttachment(id, { data: Buffer.from(await file.arrayBuffer()), name: file.name, description: text(form.description), source: text(form.source) }, actorOf(c));
      return c.json(a, 201);
    } catch (e) {
      if (e instanceof AttachmentError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });
  app.get("/requests/:rid/attachments/:aid", async (c) => {
    const { meta, data } = await ws.attachments.content(rid(c), c.req.param("aid")).catch((e) => {
      throw e instanceof AttachmentError ? new NotFoundError(e.message) : e;
    });
    return download(c, data, meta.format, meta.name);
  });
  app.delete("/requests/:rid/attachments/:aid", async (c) => {
    try {
      await preflight.removeAttachment(rid(c), c.req.param("aid"));
    } catch (e) {
      throw e instanceof AttachmentError ? new NotFoundError(e.message) : e;
    }
    return c.json({ ok: true });
  });
  app.get("/requests/:rid/preflight/:run/attachments/:aid", async (c) => {
    const { meta, data } = await preflight.fixedAttachment(rid(c), c.req.param("run"), c.req.param("aid"));
    return download(c, data, meta.format, meta.name);
  });
  app.get("/requests/:rid/preflight/:run/attachments/:aid/extract", async (c) => {
    const text = await preflight.fixedExtract(rid(c), c.req.param("run"), c.req.param("aid"));
    return c.body(text, 200, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" });
  });
  // 中断（最新でなくてもよい）。state: cancelled（中断した）/ requested（中断を頼んだ。まだ running）/ already（既に終わっている）。
  // acknowledgeStopped: 動いているか確かめられない run を、人が止まっていることを確かめて中断にする。完了した run・動いている run への
  // 確認は 409（code）。無い run は 404
  app.post("/requests/:rid/preflight/:run/cancel", async (c) => {
    const body = z.object({ acknowledgeStopped: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    try {
      const r = await preflight.cancelRun(rid(c), c.req.param("run"), { acknowledgeStopped: body.acknowledgeStopped, actor: actorOf(c) });
      return c.json({ state: r.state, message: r.message, run: r.run, ...(r.acknowledgeable ? { acknowledgeable: true } : {}) });
    } catch (e) {
      if (e instanceof CancelRefusedError) return c.json({ error: e.message, code: e.code }, 409);
      throw e;
    }
  });
  app.patch("/requests/:rid/preflight/:run/drafts/:key", async (c) => {
    // expectedTitle: 編集を始めたときの題（制御用。案には書かない）。今の題と違えば 409 で書かない
    // acceptanceCriteria: 受け入れ基準の並び全体（id は残し、無い項目に振る）。expectedCriteria: 編集を始めたときの基準（違えば 409）
    const criterion = z.object({ id: z.string().nullish(), text: z.string() });
    // sourceOps: 基準ごとの要求の根拠への操作。expectedSources: 編集を始めたときの根拠の記録（違えば 409。根拠だけの編集の競合も見る）
    const { expectedTitle, expectedCriteria, expectedSources, ...patch } = z
      .object({
        title: z.string(),
        description: z.string(),
        include: z.boolean(),
        repo: z.string().nullable(),
        acceptanceCriteria: z.array(criterion),
        sourceOps: z.array(z.object({ id: z.string(), source: z.custom<SourceOp>((v) => v !== null && typeof v === "object") })),
        expectedTitle: z.string(),
        expectedCriteria: z.array(z.object({ id: z.string(), text: z.string() })),
        expectedSources: z.array(z.custom<CriterionSource>((v) => v !== null && typeof v === "object")),
      })
      .partial()
      .parse(await c.req.json());
    if (patch.acceptanceCriteria !== undefined && expectedCriteria === undefined) {
      return c.json({ error: "受け入れ基準を直すときは expectedCriteria（編集を始めたときの基準）を渡してください", code: "acceptance_invalid" }, 400);
    }
    if (patch.sourceOps?.length && expectedSources === undefined) {
      return c.json({ error: "要求の根拠を直すときは expectedSources（編集を始めたときの根拠の記録）を渡してください", code: "requirement_invalid" }, 400);
    }
    return c.json(await preflight.updateDraft(rid(c), c.req.param("run"), c.req.param("key"), patch, { expectedTitle, expectedCriteria, expectedSources, actor: actorOf(c) }));
  });
  /** 子の要望の案（分割の run）を直す。expectedTitle は上と同じ */
  app.patch("/requests/:rid/preflight/:run/children/:key", async (c) => {
    const { expectedTitle, ...patch } = z
      .object({ title: z.string(), description: z.string(), include: z.boolean(), expectedTitle: z.string() })
      .partial()
      .parse(await c.req.json());
    return c.json(await preflight.updateChild(rid(c), c.req.param("run"), c.req.param("key"), patch, { expectedTitle }));
  });
  app.get("/requests/:rid/preflight/:run/materialize", async (c) => c.json(await preflight.previewMaterialize(rid(c), c.req.param("run"))));
  app.post("/requests/:rid/preflight/:run/materialize", async (c) => {
    const body = z
      .object({ archive: z.array(z.object({ id: z.string(), rev: z.number().int().optional() })).optional(), version: z.string().optional() })
      .parse(await c.req.json().catch(() => ({})));
    const run = await preflight.get(rid(c), c.req.param("run"));
    // 分割の run は子の要望を作る（version: 確認したときの子の案の版。違えば 409 drafts_changed）
    if (run?.children) {
      const r = await preflight.adopt(rid(c), c.req.param("run"), actorOf(c), { version: body.version });
      return c.json(r, r.failed.length ? 207 : 201);
    }
    return c.json(await preflight.materialize(rid(c), c.req.param("run"), actorOf(c), { archive: body.archive }), 201);
  });

  // --- 横断 --------------------------------------------------------------
  app.get("/tasks", (c) => {
    const { status, area, q, blocked, review } = c.req.query();
    return c.json(listTasks(ctx, { status: status?.split(","), area, q, blocked: blocked === "true", review: review === "true" }));
  });
  /** 参照・タイトルから対象を特定する（?request= で今の要望を優先） */
  app.get("/resolve", (c) => c.json(resolve(ctx, c.req.query("q") ?? "", c.req.query("request"))));

  // --- events (SSE) ------------------------------------------------------
  app.get("/events", (c) => eventStream(c, (push) => ws.on(push)));

  return app;
}

/** 変更の知らせを SSE で流す（subscribe は知らせを受け取る関数を登録し、外す関数を返す）。25 秒ごとに ping */
export function eventStream(c: Context, subscribe: (push: (e: ServerEvent) => void) => () => void) {
  return streamSSE(c, async (stream) => {
    const queue: ServerEvent[] = [];
    let wake: (() => void) | undefined;
    const off = subscribe((e) => {
      queue.push(e);
      wake?.();
    });
    stream.onAbort(() => {
      off();
      wake?.();
    });
    while (!stream.aborted) {
      if (!queue.length) {
        await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(25000)]);
        wake = undefined;
        if (!queue.length) await stream.writeSSE({ event: "ping", data: "" });
      }
      while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
    }
  });
}
