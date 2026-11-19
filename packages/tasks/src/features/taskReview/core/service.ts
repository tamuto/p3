import { normalizeTaskId } from "../../../shared/refs.ts";
import type { TaskReviewInput, TaskReviewRecord, TaskReviewResult, TaskReviewRun } from "../shared/taskReview.ts";
import { currentOwner, type OwnerProbe, type OwnerState } from "../../../core/preflight/owner.ts";
import type { Summarizer } from "../../../core/preflight/engine.ts";
import type { ResolvedRef } from "../../../core/repoRefs.ts";
import { classifyAiFailure, pickReviewer, ReviewRunner, startedNow } from "../../../core/reviewRuns.ts";
import type { Workspace } from "../../../core/store/workspace.ts";
import { extractTaskReview, TaskReviewRejected, type ExtractOptions } from "./material.ts";
import { InvalidTaskReview, MATERIAL_MOUNT, parseTaskReview, TASK_REVIEW_INPUT_LIMIT, taskReviewPrompt } from "./review.ts";
import { newTaskReviewRunId, parseTaskReviewKey } from "./store.ts";

/**
 * タスクの AI レビューを実行して記録する（CLI・API はここを呼ぶ）。材料は material.ts、依頼文と結果の確かめ方は review.ts、
 * 保存は store.ts、実行の骨組み（二重の開始・時間切れ・取消・回復・遅れた結果の拒否）は reviewRuns.ts の ReviewRunner（マイルストーンレビューと共通）。
 *
 *   - 頼む先は Preflight と同じ Codex の接続（ask。認証・パスの対応・診断・時間と使用量の上限・取消を共有する）。毎回新しいスレッドで、
 *     固定した材料のフォルダだけを読むだけでマウントする。Mock は明示したときだけ（失敗しても Mock に切り替えない）
 *   - Preflight の担当が agent のプロジェクトでは、Codex で実行することを人が明示（engine の指定）したときだけ始める
 *     （agent の設定を Codex を使う同意とみなさない）
 *   - プレビューで見た材料の hash（expectedHash）を渡すと、始めるときに材料が変わっていれば断る（確かめ直してもらう）
 *   - 同じタスクで実行中の run は1つだけ。別のタスク・プロジェクトは独立
 *   - 結果はタスクの状態・済み・基準・証拠・要望の状態を変えず、済みの条件にもしない
 */

export const TASK_REVIEW_TIMEOUT_MS = 20 * 60_000;

export type TaskReviewEngine = "codex" | "mock";

export interface TaskReviewStartOptions extends ExtractOptions {
  engine?: TaskReviewEngine;
  /** プレビューで見た材料の hash（違えば changed で断る） */
  expectedHash?: string;
}

/** 取得の結果。running の run には所有者の状態（local: このプロセス）を添える */
export interface TaskReviewDetail extends TaskReviewRecord {
  owner?: { state: "local" } | OwnerState;
}

/** プレビュー（今の材料の要約と hash。何も書かない） */
export interface TaskReviewPreview {
  input: TaskReviewInput;
  /** Codex で実行するには engine の明示が要る（Preflight の担当が agent） */
  engineRequired: boolean;
}

export class TaskReviewService {
  private runner: ReviewRunner<TaskReviewRun, TaskReviewResult, TaskReviewRecord>;

  constructor(
    private ws: Workspace,
    private reviewers: Partial<Record<TaskReviewEngine, Summarizer>>,
    private opts: { timeoutMs?: number; engine?: () => Promise<TaskReviewEngine>; probe?: OwnerProbe; pollMs?: number } = {},
  ) {
    this.runner = new ReviewRunner(ws.taskReviews, { timeoutMs: opts.timeoutMs ?? TASK_REVIEW_TIMEOUT_MS, probe: opts.probe, pollMs: opts.pollMs, emit: (r) => this.emit(r) });
  }

  private get store() {
    return this.ws.taskReviews;
  }

  /** <要望ID>/<タスクID>（T3 / 3 も T003 にそろえる） */
  key(rid: string, tid: string): string {
    const k = `${rid}/${normalizeTaskId(tid) ?? tid}`;
    parseTaskReviewKey(k);
    return k;
  }

  private emit(r: Pick<TaskReviewRun, "id" | "request" | "task" | "status">) {
    this.ws.emit({ type: "task-review", id: r.id, request: r.request, task: r.task, status: r.status });
  }

  private engineRequired(): boolean {
    return this.ws.project.preflight.runner === "agent";
  }

  /** 今の材料（何も書かない）。始めるときと同じ規則で断る */
  async preview(rid: string, tid: string, opts: ExtractOptions = {}): Promise<TaskReviewPreview> {
    const { tid: t } = parseTaskReviewKey(this.key(rid, tid));
    const { input } = await extractTaskReview(this.ws.dataDir, rid, t, this.ws.refs(), opts);
    return { input, engineRequired: this.engineRequired() };
  }

  /** 始める（終わるのは wait で待つ）。材料はここで固定する */
  async start(rid: string, tid: string, actor?: string, opts: TaskReviewStartOptions = {}): Promise<TaskReviewRun> {
    const key = this.key(rid, tid);
    const t = parseTaskReviewKey(key).tid;
    if (this.engineRequired() && !opts.engine) {
      throw new TaskReviewRejected(
        "engine_required",
        `このプロジェクトの Preflight の担当は agent です。タスクのレビューを Codex で実行するなら、明示してください（p3 review ${key} --engine codex、画面では「Codex で実行する」を選ぶ）`,
      );
    }
    const refs = this.ws.refs();
    const { input, files } = await extractTaskReview(this.ws.dataDir, rid, t, refs, opts);
    if (opts.expectedHash !== undefined && opts.expectedHash !== input.hash) {
      throw new TaskReviewRejected("material_changed", `確かめた後で材料が変わりました（本文・基準・証拠・比較対象・観点のどれか）。もう一度確かめてから始めてください`);
    }
    const { instructions, prompt, size } = taskReviewPrompt(input);
    if (size > TASK_REVIEW_INPUT_LIMIT) throw new TaskReviewRejected("too_large", `材料が上限を超えています（${size} 文字 / 上限 ${TASK_REVIEW_INPUT_LIMIT} 文字）。切り詰めずに断ります。比較対象を絞ってください`);
    const { name, reviewer } = await pickReviewer(this.reviewers, opts.engine, this.opts.engine);
    if (!reviewer) throw new TaskReviewRejected("unavailable", `レビューを頼む先（${name}）がありません`);
    const run: TaskReviewRun = {
      id: newTaskReviewRunId(),
      request: rid,
      task: t,
      status: "running",
      engine: name,
      startedAt: startedNow(),
      ...(actor ? { startedBy: actor } : {}),
      ...(currentOwner() ? { owner: currentOwner() } : {}),
      inputHash: input.hash,
      log: [],
    };
    await this.runner.begin(
      key,
      () => this.store.create(input, files, run),
      (busy) => {
        const hint =
          busy.owner.state === "unknown"
            ? `。実行しているプロセスを確かめられません（${busy.owner.reason}）。止まっていると確かめたら p3 review-cancel ${key} ${busy.run.id} --acknowledge-stopped で中断できます`
            : "。終わるのを待つか取り消してください";
        return new TaskReviewRejected("running", `${key} のレビューは実行中です（${busy.run.id}）${hint}`, busy.run.id);
      },
    );
    const material: ResolvedRef = { name: MATERIAL_MOUNT, mount: MATERIAL_MOUNT, role: "固定したレビューの材料", readFirst: true, writable: false, map: [], status: "ok", local: this.store.materialDir(key, run.id) };
    this.runner.launch(
      key,
      run,
      async (push, signal) => {
        push({
          kind: "info",
          text: `材料: 比較項目 ${input.items.length} 件・比較対象 ${input.targets.map((x) => `${x.repo} ${x.kind === "range" ? `${x.range!.base.slice(0, 7)}..${x.range!.head.slice(0, 7)}` : x.commits.map((c) => c.sha.slice(0, 7)).join(",")}`).join(" / ")}・ファイル ${input.files.length} 件`,
        });
        const r = await reviewer.ask({ instructions, prompt, refs: [material], label: "タスクのレビュー" }, push, signal);
        if (signal.aborted) throw signal.reason;
        return { result: parseTaskReview(r.message, input, r.model), end: r.model ? { model: r.model } : {} };
      },
      (e) => classifyAiFailure(e, (x) => x instanceof InvalidTaskReview),
    );
    return run;
  }

  async recover(key: string): Promise<void> {
    await this.runner.recover(key);
  }

  async list(rid: string, tid: string) {
    const key = this.key(rid, tid);
    await this.recover(key);
    return this.store.list(key);
  }

  async get(rid: string, tid: string, run: string): Promise<TaskReviewDetail> {
    return this.runner.get(this.key(rid, tid), run);
  }

  async cancel(rid: string, tid: string, run: string, by?: string, opts: { acknowledgeStopped?: boolean } = {}): Promise<{ run: TaskReviewRun; requested: boolean }> {
    return this.runner.cancel(this.key(rid, tid), run, by, opts);
  }

  /** 終わるまで待つ（このプロセスの run だけ） */
  async wait(rid: string, tid: string, run: string): Promise<TaskReviewDetail> {
    await this.runner.waitLocal(run);
    return this.get(rid, tid, run);
  }

  running(): number {
    return this.runner.running();
  }

  async settle(opts: { cancel?: boolean } = {}): Promise<void> {
    await this.runner.settle(opts);
  }
}
