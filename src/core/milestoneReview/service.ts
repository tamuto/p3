import type { ReviewFailure, ReviewInput, ReviewRecord, ReviewResult, ReviewRun } from "../../shared/milestoneReview.ts";
import type { PreflightLogEntry } from "../../shared/types.ts";
import { ChatGptAuthError } from "../chatgpt.ts";
import { CodexUnavailableError, CodexUsageLimitError } from "../preflight/codexEngine.ts";
import { currentOwner, ownerState, systemProbe, type OwnerProbe, type OwnerState } from "../preflight/owner.ts";
import type { Summarizer } from "../releaseNotes/generate.ts";
import type { ResolvedRef } from "../repoRefs.ts";
import type { Workspace } from "../store/workspace.ts";
import { extractReviewInput } from "./material.ts";
import { InvalidReview, parseReview, REVIEW_INPUT_LIMIT, reviewPrompt, type ReviewLocals } from "./review.ts";
import { checkReviewMilestoneId, newReviewRunId, ReviewStoreError } from "./store.ts";

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
    readonly code: "unknown_milestone" | "no_goals" | "too_large" | "running" | "unavailable",
    message: string,
    readonly running?: string,
  ) {
    super(message);
  }
}

/** 取消・中断を受け付けない（終わっている・動いている所有者がいる） */
export class ReviewCancelRefused extends Error {
  constructor(
    readonly code: "finished" | "owner_alive",
    message: string,
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

/** 開始の日時（このプロセスでは前より必ず後にする。一覧を開始の順に並べるので、同じミリ秒の開始でも順が分かるように） */
let lastStart = 0;
function startedNow(): string {
  lastStart = Math.max(Date.now(), lastStart + 1);
  return new Date(lastStart).toISOString();
}

export class MilestoneReviewService {
  private local = new Map<string, LocalJob>();

  constructor(
    private ws: Workspace,
    private reviewers: Partial<Record<ReviewEngine, Summarizer>>,
    private opts: { timeoutMs?: number; engine?: () => Promise<ReviewEngine>; probe?: OwnerProbe; pollMs?: number } = {},
  ) {}

  private get store() {
    return this.ws.milestoneReviews;
  }

  private ownerOf(r: ReviewRun): { state: "local" } | OwnerState {
    if (this.local.has(r.id)) return { state: "local" };
    return ownerState(r.owner, this.opts.probe ?? systemProbe);
  }

  /** 始める（終わるのは wait で待つ）。材料はここで固定する */
  async start(mid: string, actor?: string, engine?: ReviewEngine): Promise<ReviewRun> {
    checkReviewMilestoneId(mid);
    const refs = this.ws.refs();
    const input = await extractReviewInput(this.ws.dataDir, mid, refs);
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
      await this.recoverLocked(mid);
      for (const id of await this.store.runIds(mid)) {
        const r = await this.store.readRun(mid, id).catch(() => undefined);
        if (r?.status !== "running") continue;
        const o = this.ownerOf(r);
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
    let flushed = 0;
    // ほかのプロセスからの取消の要求を見つけ、ログを run.json に書き足す
    const poll = setInterval(() => {
      void this.store
        .withLock(mid, async () => {
          const cur = await this.store.readRun(mid, id);
          if (cur.status !== "running") return abort.abort(new Error("ended"));
          if (cur.cancelRequested) abort.abort(new Error("cancelled"));
          if (log.length !== flushed) {
            flushed = log.length;
            await this.store.updateRunning(mid, id, (r) => ({ ...r, log: [...log] }));
          }
        })
        .catch(() => undefined);
    }, this.opts.pollMs ?? 1000);
    poll.unref?.();
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
      clearInterval(poll);
    }
    try {
      const fin = await this.store.withLock(mid, () => this.store.finish(mid, id, { ...end, log: [...log] }, end.status === "completed" ? result : undefined));
      this.emit(fin);
    } catch (e) {
      // 既に終わっていた（人が中断した・回復した）: 遅れて届いた結果は取り込まない
      if (!(e instanceof ReviewStoreError && e.code === "finished")) throw e;
      this.emit({ id, milestone: mid, status: (await this.store.readRun(mid, id).catch(() => run)).status });
    }
  }

  /** 死んだと確かめられた所有者の run を失敗（crashed）にする（ロックの中で呼ぶ） */
  private async recoverLocked(mid: string): Promise<void> {
    for (const id of await this.store.runIds(mid)) {
      const r = await this.store.readRun(mid, id).catch(() => undefined);
      if (r?.status !== "running" || this.local.has(r.id)) continue;
      const o = this.ownerOf(r);
      if (o.state !== "dead") continue;
      const fin = await this.store.finish(mid, id, { status: "failed", failure: "crashed", error: `実行していたプロセスが途中で終わりました（${o.reason}）` });
      this.emit(fin);
    }
  }

  /** 死んだ所有者の run を回復する（一覧・取得の前に） */
  async recover(mid: string): Promise<void> {
    checkReviewMilestoneId(mid);
    if (!(await this.store.hasHistory(mid))) return;
    await this.store.withLock(mid, () => this.recoverLocked(mid));
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
    const out = await this.store.withLock(mid, async () => {
      const cur = await this.store.readRun(mid, run);
      if (cur.status !== "running") throw new ReviewCancelRefused("finished", `${mid}/${run} は既に終わっています（${cur.status}）`);
      const o = this.ownerOf(cur);
      if (opts.acknowledgeStopped && !local) {
        if (o.state === "alive") throw new ReviewCancelRefused("owner_alive", `${mid}/${run} を実行しているプロセスは動いています。--acknowledge-stopped ではなく取消を使ってください`);
        const at = new Date().toISOString();
        const fin = await this.store.finish(mid, run, {
          status: "cancelled",
          abandoned: { at, ...(by ? { by } : {}) },
          error: "人が中断しました（ほかの環境で動いているプロセスを止めたとは限りません）",
        });
        return { run: fin, requested: false };
      }
      if (o.state === "dead") {
        const fin = await this.store.finish(mid, run, { status: "failed", failure: "crashed", error: `実行していたプロセスが途中で終わりました（${o.reason}）` });
        return { run: fin, requested: false };
      }
      const next = await this.store.updateRunning(mid, run, (r) => ({ ...r, cancelRequested: { at: new Date().toISOString(), ...(by ? { by } : {}) } }));
      return { run: next, requested: true };
    });
    local?.abort.abort(new Error("cancelled"));
    this.emit(out.run);
    return out;
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
