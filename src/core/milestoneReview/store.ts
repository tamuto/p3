import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  REVIEW_STATUSES,
  REVIEW_VERDICTS,
  type ReviewInput,
  type ReviewListItem,
  type ReviewRecord,
  type ReviewResult,
  type ReviewRun,
  type ReviewVerdict,
} from "../../shared/milestoneReview.ts";
import { withFileLock, writeFileAtomic } from "../store/fsutil.ts";

/**
 * マイルストーンレビューの履歴。
 *
 *   <data>/milestone-reviews/<マイルストーンID>/<run>/input.json    固定した比較材料（作ったら変えない）
 *   <data>/milestone-reviews/<マイルストーンID>/<run>/run.json      実行の記録（状態・実行者・エンジン・所有者・失敗の理由・取消の要求）
 *   <data>/milestone-reviews/<マイルストーンID>/<run>/review.json   結果（completed のときだけ。書き終えてから completed にする）
 *   <data>/milestone-reviews/.locks/<マイルストーンID>.lock        状態を変えるときのロック（プロセス間）
 *
 *   - 状態は running → completed / failed / cancelled の一方向。終わった run は変えない（遅れて届いた結果も取り込まない）
 *   - パスの ID（マイルストーン・run）は形を確かめ、保存先の外を指すもの・「.」「..」は断る。同じ run は作り直さない
 *   - ファイルは tmp に書いてから rename する。壊れた記録は「無い」と分けて返す（一覧からも隠さない）
 *   - 今の要望・目的と比べても、過去の input / review は変えない
 */

export const MILESTONE_REVIEWS_DIR = "milestone-reviews";
const MILESTONE_ID = /^[A-Za-z0-9._-]+$/;
const RUN_ID = /^MR-\d{8}-\d{6}-[0-9a-f]{4}$/;

/** 履歴の操作の失敗。not_found: 無い / broken: 読めない / bad_id: ID が使えない / exists: 既にある / finished: 終わった run */
export class ReviewStoreError extends Error {
  constructor(
    readonly code: "not_found" | "broken" | "bad_id" | "exists" | "finished",
    message: string,
  ) {
    super(message);
  }
}

export function checkReviewMilestoneId(id: string): void {
  if (!MILESTONE_ID.test(id) || id === "." || id === "..") throw new ReviewStoreError("bad_id", `マイルストーンの ID に使えません: ${JSON.stringify(id)}（英数字と . _ -）`);
}

export function checkRunId(id: string): void {
  if (!RUN_ID.test(id)) throw new ReviewStoreError("bad_id", `レビューの run の ID ではありません: ${JSON.stringify(id)}（MR-YYYYMMDD-HHMMSS-xxxx）`);
}

export function newReviewRunId(now = new Date()): string {
  const s = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `MR-${s}-${randomBytes(2).toString("hex")}`;
}

const isTerminal = (r: ReviewRun) => r.status !== "running";

export class MilestoneReviewStore {
  constructor(readonly dataDir: string) {}

  get dir() {
    return join(this.dataDir, MILESTONE_REVIEWS_DIR);
  }

  private within(...parts: string[]): string {
    const p = resolve(this.dir, ...parts);
    if (!p.startsWith(resolve(this.dir) + sep)) throw new ReviewStoreError("bad_id", `保存先の外を指します: ${parts.join("/")}`);
    return p;
  }

  milestoneDir(mid: string): string {
    checkReviewMilestoneId(mid);
    return this.within(mid);
  }

  runDir(mid: string, run: string): string {
    checkReviewMilestoneId(mid);
    checkRunId(run);
    return this.within(mid, run);
  }

  /** マイルストーンの状態を変えるときのロック（ほかのプロセスの開始・終わり・取消と1つずつにする） */
  withLock<T>(mid: string, fn: () => Promise<T>): Promise<T> {
    checkReviewMilestoneId(mid);
    return withFileLock(join(this.dir, ".locks", `${mid}.lock`), fn, {
      busyMessage: `マイルストーン ${mid} のレビューの記録を変えられませんでした（別のプロセスが使っています。少し待ってやり直してください）`,
    });
  }

  /** 履歴のあるマイルストーン（run のフォルダが1つでもあるもの。project.yaml に無い孤立も含む） */
  async milestones(): Promise<string[]> {
    const out: string[] = [];
    for (const d of await dirs(this.dir)) {
      if (d.startsWith(".") || !MILESTONE_ID.test(d) || d === "..") continue;
      if ((await dirs(join(this.dir, d))).some((r) => RUN_ID.test(r))) out.push(d);
    }
    return out.sort();
  }

  async hasHistory(mid: string): Promise<boolean> {
    return (await this.runIds(mid)).length > 0;
  }

  /** run の ID（新しい順） */
  async runIds(mid: string): Promise<string[]> {
    return (await dirs(this.milestoneDir(mid))).filter((r) => RUN_ID.test(r)).sort().reverse();
  }

  /**
   * 新しい run を作る（input.json と running の run.json）。同じ ID が既にあれば exists で断る（上書きしない）。
   * 呼ぶ側がロックの中で呼ぶ（同時に実行中の run を作らないため）
   */
  async create(input: ReviewInput, run: ReviewRun): Promise<void> {
    const dir = this.runDir(run.milestone, run.id);
    await mkdir(this.milestoneDir(run.milestone), { recursive: true });
    try {
      await mkdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ReviewStoreError("exists", `既にある run です: ${run.milestone}/${run.id}`);
      throw e;
    }
    await writeJson(join(dir, "input.json"), input);
    await writeJson(join(dir, "run.json"), run);
  }

  async readRun(mid: string, run: string): Promise<ReviewRun> {
    return readJson<ReviewRun>(join(this.runDir(mid, run), "run.json"), `${mid}/${run}`, checkRunShape);
  }

  async readInput(mid: string, run: string): Promise<ReviewInput> {
    return readJson<ReviewInput>(join(this.runDir(mid, run), "input.json"), `${mid}/${run} の input.json`, (x) => {
      const i = x as Partial<ReviewInput>;
      if (!i.milestone || !Array.isArray(i.units) || !Array.isArray(i.requests) || typeof i.hash !== "string") throw new Error("形が違います");
    });
  }

  async readResult(mid: string, run: string): Promise<ReviewResult> {
    return readJson<ReviewResult>(join(this.runDir(mid, run), "review.json"), `${mid}/${run} の review.json`, (x) => {
      const r = x as Partial<ReviewResult>;
      if (typeof r.overall !== "string" || !Array.isArray(r.units)) throw new Error("形が違います");
    });
  }

  /** 1回分（無ければ not_found、どれかが読めなければ broken） */
  async get(mid: string, run: string): Promise<ReviewRecord> {
    const r = await this.readRun(mid, run);
    const input = await this.readInput(mid, run);
    const result = r.status === "completed" ? await this.readResult(mid, run) : undefined;
    return { run: r, input, ...(result ? { result } : {}) };
  }

  /** 一覧（新しい順）。読めない記録も broken として出す */
  async list(mid: string): Promise<ReviewListItem[]> {
    const out: ReviewListItem[] = [];
    for (const id of await this.runIds(mid)) {
      try {
        const rec = await this.get(mid, id);
        const verdicts: Partial<Record<ReviewVerdict, number>> = {};
        for (const u of rec.result?.units ?? []) verdicts[u.verdict] = (verdicts[u.verdict] ?? 0) + 1;
        out.push({
          state: "ok",
          run: rec.run,
          units: rec.input!.units,
          ...(rec.input!.milestone.purpose ? { purpose: rec.input!.milestone.purpose } : {}),
          inputHash: rec.input!.hash,
          ...(rec.result ? { verdicts } : {}),
        });
      } catch (e) {
        out.push({ state: "broken", id, error: (e as Error).message });
      }
    }
    return out;
  }

  /** run.json を書き換える（呼ぶ側がロックの中で呼ぶ）。終わった run は finished で断る */
  async updateRunning(mid: string, run: string, fn: (r: ReviewRun) => ReviewRun): Promise<ReviewRun> {
    const cur = await this.readRun(mid, run);
    if (isTerminal(cur)) throw new ReviewStoreError("finished", `${mid}/${run} は既に終わっています（${cur.status}）`);
    const next = fn(cur);
    await writeJson(join(this.runDir(mid, run), "run.json"), next);
    return next;
  }

  /**
   * 終わりにする（呼ぶ側がロックの中で呼ぶ）。completed は結果を書き終えてから run.json を completed にする。
   * 既に終わっていれば finished で断り、何も書かない
   */
  async finish(mid: string, run: string, patch: Partial<ReviewRun> & { status: Exclude<ReviewRun["status"], "running"> }, result?: ReviewResult): Promise<ReviewRun> {
    const cur = await this.readRun(mid, run);
    if (isTerminal(cur)) throw new ReviewStoreError("finished", `${mid}/${run} は既に終わっています（${cur.status}）`);
    if (patch.status === "completed") {
      if (!result) throw new Error("completed には結果が要ります");
      await writeJson(join(this.runDir(mid, run), "review.json"), result);
    }
    const next: ReviewRun = { ...cur, ...patch, finishedAt: patch.finishedAt ?? new Date().toISOString() };
    await writeJson(join(this.runDir(mid, run), "run.json"), next);
    return next;
  }
}

function checkRunShape(x: unknown) {
  const r = x as Partial<ReviewRun>;
  if (typeof r.id !== "string" || typeof r.milestone !== "string" || !REVIEW_STATUSES.includes(r.status as never) || typeof r.startedAt !== "string") throw new Error("形が違います");
  if (!Array.isArray(r.log)) throw new Error("log がありません");
}

/** 判定の区分か */
export const isVerdict = (v: unknown): v is ReviewVerdict => REVIEW_VERDICTS.includes(v as ReviewVerdict);

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function writeJson(path: string, v: unknown) {
  await writeFileAtomic(path, `${JSON.stringify(v, null, 2)}\n`);
}

async function readJson<T>(path: string, label: string, check: (x: unknown) => void): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ReviewStoreError("not_found", `レビューの記録がありません: ${label}`);
    throw e;
  }
  try {
    const v = JSON.parse(text) as unknown;
    check(v);
    return v as T;
  } catch (e) {
    throw new ReviewStoreError("broken", `レビューの記録を読めません: ${label}（${(e as Error).message}）`);
  }
}
