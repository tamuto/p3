import { normalizeTaskId } from "../../shared/refs.ts";
import type { TaskReviewFailure, TaskReviewInput, TaskReviewRecord, TaskReviewResult, TaskReviewRun } from "../../shared/taskReview.ts";
import type { PreflightLogEntry } from "../../shared/types.ts";
import { ChatGptAuthError } from "../chatgpt.ts";
import { CodexUnavailableError, CodexUsageLimitError } from "../preflight/codexEngine.ts";
import { currentOwner, type OwnerProbe, type OwnerState } from "../preflight/owner.ts";
import type { Summarizer } from "../releaseNotes/generate.ts";
import type { ResolvedRef } from "../repoRefs.ts";
import { RunControl, startedNow } from "../reviewRuns.ts";
import type { Workspace } from "../store/workspace.ts";
import { extractTaskReview, TaskReviewRejected, type ExtractOptions } from "./material.ts";
import { InvalidTaskReview, MATERIAL_MOUNT, parseTaskReview, TASK_REVIEW_INPUT_LIMIT, taskReviewPrompt } from "./review.ts";
import { newTaskReviewRunId, parseTaskReviewKey } from "./store.ts";

/**
 * タスクの AI レビューを実行して記録する（CLI・API はここを呼ぶ）。材料は material.ts、依頼文と結果の確かめ方は review.ts、
 * 保存は store.ts、実行中の run の扱いは reviewRuns.ts（マイルストーンレビューと共通）。
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

interface LocalJob {
  key: string;
  abort: AbortController;
  done: Promise<void>;
}

export class TaskReviewService {
  private local = new Map<string, LocalJob>();
  private control: RunControl<TaskReviewRun, TaskReviewResult>;

  constructor(
    private ws: Workspace,
    private reviewers: Partial<Record<TaskReviewEngine, Summarizer>>,
    private opts: { timeoutMs?: number; engine?: () => Promise<TaskReviewEngine>; probe?: OwnerProbe; pollMs?: number } = {},
  ) {
    this.control = new RunControl(ws.taskReviews, this.local, opts.probe, (_k, r) => this.emit(r));
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
      throw new TaskReviewRejected("changed", `確かめた後で材料が変わりました（本文・基準・証拠・比較対象・観点のどれか）。もう一度確かめてから始めてください`);
    }
    const { instructions, prompt, size } = taskReviewPrompt(input);
    if (size > TASK_REVIEW_INPUT_LIMIT) throw new TaskReviewRejected("too_large", `材料が上限を超えています（${size} 文字 / 上限 ${TASK_REVIEW_INPUT_LIMIT} 文字）。切り詰めずに断ります。比較対象を絞ってください`);
    const name = opts.engine ?? (await this.opts.engine?.().catch(() => "codex" as const)) ?? "codex";
    const reviewer = this.reviewers[name];
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
    await this.store.withLock(key, async () => {
      const busy = await this.control.runningLocked(key);
      if (busy) {
        const hint =
          busy.owner.state === "unknown"
            ? `。実行しているプロセスを確かめられません（${busy.owner.reason}）。止まっていると確かめたら p3 review-cancel ${key} ${busy.run.id} --acknowledge-stopped で中断できます`
            : "。終わるのを待つか取り消してください";
        throw new TaskReviewRejected("running", `${key} のレビューは実行中です（${busy.run.id}）${hint}`, busy.run.id);
      }
      await this.store.create(input, files, run);
    });
    const abort = new AbortController();
    const job: LocalJob = { key, abort, done: Promise.resolve() };
    this.local.set(run.id, job);
    this.emit(run);
    const material: ResolvedRef = { name: MATERIAL_MOUNT, mount: MATERIAL_MOUNT, role: "固定したレビューの材料", readFirst: true, writable: false, map: [], status: "ok", local: this.store.materialDir(key, run.id) };
    job.done = this.execute(key, run, input, { instructions, prompt, material }, reviewer, abort).finally(() => this.local.delete(run.id));
    return run;
  }

  private async execute(
    key: string,
    run: TaskReviewRun,
    input: TaskReviewInput,
    ask: { instructions: string; prompt: string; material: ResolvedRef },
    reviewer: Summarizer,
    abort: AbortController,
  ): Promise<void> {
    const log: PreflightLogEntry[] = [];
    const push = (e: Omit<PreflightLogEntry, "at">) => log.push({ at: new Date().toISOString(), ...e });
    const timeoutMs = this.opts.timeoutMs ?? TASK_REVIEW_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([abort.signal, timeout]);
    const stopWatch = this.control.watch(key, run.id, log, abort, this.opts.pollMs ?? 1000);
    let end: Partial<TaskReviewRun> & { status: Exclude<TaskReviewRun["status"], "running"> };
    let result: TaskReviewResult | undefined;
    try {
      push({
        kind: "info",
        text: `材料: 比較項目 ${input.items.length} 件・比較対象 ${input.targets.map((t) => `${t.repo} ${t.kind === "range" ? `${t.range!.base.slice(0, 7)}..${t.range!.head.slice(0, 7)}` : t.commits.map((c) => c.sha.slice(0, 7)).join(",")}`).join(" / ")}・ファイル ${input.files.length} 件`,
      });
      const r = await reviewer.ask({ instructions: ask.instructions, prompt: ask.prompt, refs: [ask.material], label: "タスクのレビュー" }, push, signal);
      if (signal.aborted) throw signal.reason;
      result = parseTaskReview(r.message, input, r.model);
      end = { status: "completed", ...(r.model ? { model: r.model } : {}) };
    } catch (e) {
      if (abort.signal.aborted) end = { status: "cancelled", error: "取り消しました" };
      else if (timeout.aborted) end = { status: "failed", failure: "timeout", error: `時間切れです（${Math.round(timeoutMs / 1000)} 秒）` };
      else {
        const [failure, error] = classify(e);
        end = { status: "failed", failure, error };
      }
      push({ kind: "error", text: end.error! });
    } finally {
      stopWatch();
    }
    // 既に終わっていた（人が中断した・回復した）なら、遅れて届いた結果は取り込まない
    await this.control.end(key, run.id, { ...end, log: [...log] }, result);
  }

  async recover(key: string): Promise<void> {
    if (!(await this.store.hasHistory(key))) return;
    await this.store.withLock(key, () => this.control.recoverLocked(key));
  }

  async list(rid: string, tid: string) {
    const key = this.key(rid, tid);
    await this.recover(key);
    return this.store.list(key);
  }

  async get(rid: string, tid: string, run: string): Promise<TaskReviewDetail> {
    const key = this.key(rid, tid);
    await this.recover(key);
    const rec = await this.store.get(key, run);
    return { ...rec, ...(rec.run.status === "running" ? { owner: this.control.ownerOf(rec.run) } : {}) };
  }

  async cancel(rid: string, tid: string, run: string, by?: string, opts: { acknowledgeStopped?: boolean } = {}): Promise<{ run: TaskReviewRun; requested: boolean }> {
    const key = this.key(rid, tid);
    const local = this.local.get(run);
    return this.control.cancel(key, run, by, { ...opts, label: `${key}/${run}`, abortLocal: () => local?.abort.abort(new Error("cancelled")) });
  }

  /** 終わるまで待つ（このプロセスの run だけ） */
  async wait(rid: string, tid: string, run: string): Promise<TaskReviewDetail> {
    await this.local.get(run)?.done;
    return this.get(rid, tid, run);
  }

  running(): number {
    return this.local.size;
  }

  async settle(opts: { cancel?: boolean } = {}): Promise<void> {
    const jobs = [...this.local.values()];
    if (opts.cancel) for (const j of jobs) j.abort.abort(new Error("cancelled"));
    await Promise.allSettled(jobs.map((j) => j.done));
  }
}

function classify(e: unknown): [TaskReviewFailure, string] {
  const msg = (e as Error)?.message ?? String(e);
  if (e instanceof CodexUnavailableError || e instanceof ChatGptAuthError) return ["unavailable", msg];
  if (e instanceof CodexUsageLimitError) return ["usage_limit", msg];
  if (e instanceof InvalidTaskReview) return ["invalid_output", msg];
  return ["error", msg];
}
