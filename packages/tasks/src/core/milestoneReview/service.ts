import type { ReviewFailure, ReviewInput, ReviewRecord, ReviewResult, ReviewRun } from "../../shared/milestoneReview.ts";
import type { PreflightLogEntry } from "../../shared/types.ts";
import { ChatGptAuthError } from "../chatgpt.ts";
import { CodexUnavailableError, CodexUsageLimitError } from "../preflight/codexEngine.ts";
import { currentOwner, type OwnerProbe, type OwnerState } from "../preflight/owner.ts";
import { ReviewCancelRefused, RunControl, startedNow } from "../reviewRuns.ts";
import type { Summarizer } from "../releaseNotes/generate.ts";
import type { ResolvedRef } from "../repoRefs.ts";
import type { Workspace } from "../store/workspace.ts";
import { extractReviewInput } from "./material.ts";
import { InvalidReview, parseReview, REVIEW_INPUT_LIMIT, reviewPrompt, type ReviewLocals } from "./review.ts";
import { checkReviewMilestoneId, newReviewRunId } from "./store.ts";

export { ReviewCancelRefused };

/**
 * マイルストーンレビューを任意のときに実行して記録する（CLI・API はここを呼ぶ）。材料の規則は material.ts、依頼文と結果の
 * 確かめ方は review.ts、保存は store.ts。
 *
 *   - 頼む先は Preflight と同じ Codex の接続（CodexWorkspaceEngine の ask。認証・診断・使用量の上限・取消を共有する）。
 *     参照先（このマシンのパス）を Preflight と同じく読むだけでマウントし、コードと git の履歴を読ませる。
 *     Mock は明示したときだけ（失敗しても Mock に切り替えない）
 *   - 同じデータ・同じマイルストーンで実行中の run は1つだけ（プロセスの間もロックの中で確かめる）。別のマイルストーンは独立
 *   - 実行しているプロセスが死んだと確かめられた run（owner.ts の ownerState が dead）だけ、失敗（crashed）として終わりにする。
 *     分からない・ほかの環境の run は自動で終わりにしない。人が明示して中断できる（abandon。ほかの環境のプロセスを止めたとは限らない）
 *   - 取消は、このプロセスの run なら止め、ほかのプロセスの run なら要求を run.json に書く（所有者が見つけて止める）
 *   - 終わりの状態はロックの中で、まだ実行中かを確かめてから書く（中断した後に届いた結果は取り込まない）
 *   - レビューの結果は要望の状態・リリースノート・リリース済みを変えず、完了やリリースの条件にもしない
 */

/** 1回の時間の上限（既定） */
export const REVIEW_TIMEOUT_MS = 20 * 60_000;

export type ReviewEngine = "codex" | "mock";

/** 始められない（Codex は呼んでいない） */
export class ReviewRejected extends Error {
  constructor(
    /** unknown_milestone: 無い / no_goals: 目的も予定機能も無い / too_large: 入力が上限を超える / running: 実行中 / unavailable: 頼む先が無い */
    readonly code: "unknown_milestone" | "no_goals" | "too_large" | "running" | "unavailable" | "material_changed",
    message: string,
    readonly running?: string,
  ) {
    super(message);
  }
}

/** 取得の結果。running の run には所有者の状態（local: このプロセス）を添える */
export interface ReviewDetail extends ReviewRecord {
  owner?: { state: "local" } | OwnerState;
}

interface LocalJob {
  mid: string;
  abort: AbortController;
  done: Promise<void>;
}

export class MilestoneReviewService {
  private local = new Map<string, LocalJob>();
  /** 実行中の run の扱い（回復・取消・取消の要求の見つけ方・終わり）は reviewRuns.ts と共通 */
  private control: RunControl<ReviewRun, ReviewResult>;

  constructor(
    private ws: Workspace,
    private reviewers: Partial<Record<ReviewEngine, Summarizer>>,
    private opts: { timeoutMs?: number; engine?: () => Promise<ReviewEngine>; probe?: OwnerProbe; pollMs?: number } = {},
  ) {
    this.control = new RunControl(ws.milestoneReviews, this.local, opts.probe, (_k, r) => this.emit(r));
  }

  private get store() {
    return this.ws.milestoneReviews;
  }

  private ownerOf(r: ReviewRun): { state: "local" } | OwnerState {
    return this.control.ownerOf(r);
  }

  /** 始める（終わるのは wait で待つ）。材料はここで固定する */
  async start(mid: string, actor?: string, engine?: ReviewEngine, opts: { expectedHash?: string } = {}): Promise<ReviewRun> {
    checkReviewMilestoneId(mid);
    const refs = this.ws.refs();
    const input = await extractReviewInput(this.ws.dataDir, mid, refs);
    // 画面で確かめた材料（品質基準を含む）から変わっていれば始めない
    if (opts.expectedHash !== undefined && opts.expectedHash !== input.hash) {
      throw new ReviewRejected("material_changed", "確かめた後で材料（目的・要望・タスク・コード・品質基準）が変わりました。もう一度確かめてから始めてください");
    }
    if (!input.milestone.known) throw new ReviewRejected("unknown_milestone", `マイルストーンがありません: ${mid}`);
    if (!input.units.length) {
      throw new ReviewRejected(
        "no_goals",
        `マイルストーン ${mid} に目的も予定機能もありません。先に書いてください（画面のリリースノートの「マイルストーン」タブ、または p3 milestone purpose ${mid} --file 目的.md / p3 milestone goal add ${mid} "文"）`,
      );
    }
    const { instructions, prompt, size } = reviewPrompt(input);
    if (size > REVIEW_INPUT_LIMIT) {
      throw new ReviewRejected("too_large", `材料が上限を超えています（${size} 文字 / 上限 ${REVIEW_INPUT_LIMIT} 文字）。切り詰めずに断ります。マイルストーンを分けるか、要望の本文を整理してください`);
    }
    const name = engine ?? (await this.opts.engine?.().catch(() => "codex" as const)) ?? "codex";
    const reviewer = this.reviewers[name];
    if (!reviewer) throw new ReviewRejected("unavailable", `レビューを頼む先（${name}）がありません`);
    const run: ReviewRun = {
      id: newReviewRunId(),
      milestone: mid,
      status: "running",
      engine: name,
      startedAt: startedNow(),
      ...(actor ? { startedBy: actor } : {}),
      ...(currentOwner() ? { owner: currentOwner() } : {}),
      inputHash: input.hash,
      log: [],
    };
    await this.store.withLock(mid, async () => {
      const busy = await this.control.runningLocked(mid);
      if (busy) {
        const { run: r, owner: o } = busy;
        const hint =
          o.state === "unknown"
            ? `。実行しているプロセスを確かめられません（${o.reason}）。止まっていると確かめたら p3 milestone review-cancel ${mid} ${r.id} --acknowledge-stopped で中断できます`
            : "。終わるのを待つか取り消してください";
        throw new ReviewRejected("running", `${mid} のレビューは実行中です（${r.id}）${hint}`, r.id);
      }
      await this.store.create(input, run);
    });
    const abort = new AbortController();
    const job: LocalJob = { mid, abort, done: Promise.resolve() };
    this.local.set(run.id, job);
    this.emit(run);
    job.done = this.execute(run, input, { instructions, prompt, refs }, reviewer, abort).finally(() => this.local.delete(run.id));
    return run;
  }

  private emit(r: Pick<ReviewRun, "id" | "milestone" | "status">) {
    this.ws.emit({ type: "milestone-review", id: r.id, milestone: r.milestone, status: r.status });
  }

  private async execute(
    run: ReviewRun,
    input: ReviewInput,
    ask: { instructions: string; prompt: string; refs: readonly ResolvedRef[] },
    reviewer: Summarizer,
    abort: AbortController,
  ): Promise<void> {
    const { milestone: mid, id } = run;
    const log: PreflightLogEntry[] = [];
    const push = (e: Omit<PreflightLogEntry, "at">) => log.push({ at: new Date().toISOString(), ...e });
    const timeoutMs = this.opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([abort.signal, timeout]);
    // ほかのプロセスからの取消の要求を見つけ、ログを run.json に書き足す
    const stopWatch = this.control.watch(mid, id, log, abort, this.opts.pollMs ?? 1000);
    let end: Partial<ReviewRun> & { status: Exclude<ReviewRun["status"], "running"> };
    let result: ReviewResult | undefined;
    try {
      const code = (input.code ?? []).filter((c) => c.status === "ok");
      push({
        kind: "info",
        text: `材料: 比較単位 ${input.units.length} 件・要望 ${input.requests.length} 件・タスク ${input.requests.reduce((n, r) => n + r.tasks.length, 0)} 件・参照先 ${
          code.length ? code.map((c) => `${c.name}${c.head ? `@${c.head.slice(0, 7)}` : ""}`).join(", ") : "なし（記録だけの点検）"
        }`,
      });
      // マウントするのは、材料を取り出したときに読めた参照先だけ
      const readable = ask.refs.filter((r) => r.status === "ok" && r.local && code.some((c) => c.name === r.name));
      const r = await reviewer.ask({ instructions: ask.instructions, prompt: ask.prompt, refs: readable, label: "マイルストーンのレビュー" }, push, signal);
      if (signal.aborted) throw signal.reason;
      const locals: ReviewLocals = Object.fromEntries(readable.map((x) => [x.name, x.local!]));
      result = parseReview(r.message, input, r.model, locals);
      end = { status: "completed" };
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
    // 実行中に材料が変わったか（要望・タスク・コード・品質基準）。結果は始めたときの材料に対するもの
    if (end.status === "completed") {
      const now = await extractReviewInput(this.ws.dataDir, mid, ask.refs).catch(() => undefined);
      if (now && now.hash !== input.hash) {
        end = { ...end, inputChanged: true };
        push({ kind: "info", text: "実行中に材料が変わりました（結果は始めたときの材料に対するものです）" });
      }
    }
    // 既に終わっていた（人が中断した・回復した）なら、遅れて届いた結果は取り込まない
    await this.control.end(mid, id, { ...end, log: [...log] }, result);
  }

  /** 死んだ所有者の run を回復する（一覧・取得の前に） */
  async recover(mid: string): Promise<void> {
    checkReviewMilestoneId(mid);
    if (!(await this.store.hasHistory(mid))) return;
    await this.store.withLock(mid, () => this.control.recoverLocked(mid));
  }

  async list(mid: string) {
    await this.recover(mid);
    return this.store.list(mid);
  }

  async get(mid: string, run: string): Promise<ReviewDetail> {
    await this.recover(mid);
    const rec = await this.store.get(mid, run);
    return { ...rec, ...(rec.run.status === "running" ? { owner: this.ownerOf(rec.run) } : {}) };
  }

  /**
   * 取り消す。このプロセスの run は止め、ほかのプロセスの run は要求を書く（所有者が見つけて止める）。
   * acknowledgeStopped: 人が「実行しているプロセスは止まっている」と確かめた。所有者が分からない run を、記録の上で中断にする
   * （動いていると確かめられる所有者がいれば断る。ほかの環境のプロセスを止めたとは限らない）
   */
  async cancel(mid: string, run: string, by?: string, opts: { acknowledgeStopped?: boolean } = {}): Promise<{ run: ReviewRun; requested: boolean }> {
    checkReviewMilestoneId(mid);
    const local = this.local.get(run);
    return this.control.cancel(mid, run, by, { ...opts, label: `${mid}/${run}`, abortLocal: () => local?.abort.abort(new Error("cancelled")) });
  }

  /** 終わるまで待つ（このプロセスの run だけ） */
  async wait(mid: string, run: string): Promise<ReviewDetail> {
    await this.local.get(run)?.done;
    return this.get(mid, run);
  }

  /** このプロセスで実行中の数 */
  running(): number {
    return this.local.size;
  }

  /** このプロセスの実行が全部終わるまで待つ（cancel: 先に全部を取り消す） */
  async settle(opts: { cancel?: boolean } = {}): Promise<void> {
    const jobs = [...this.local.values()];
    if (opts.cancel) for (const j of jobs) j.abort.abort(new Error("cancelled"));
    await Promise.allSettled(jobs.map((j) => j.done));
  }
}

function classify(e: unknown): [ReviewFailure, string] {
  const msg = (e as Error)?.message ?? String(e);
  if (e instanceof CodexUnavailableError || e instanceof ChatGptAuthError) return ["unavailable", msg];
  if (e instanceof CodexUsageLimitError) return ["usage_limit", msg];
  if (e instanceof InvalidReview) return ["invalid_output", msg];
  return ["error", msg];
}
