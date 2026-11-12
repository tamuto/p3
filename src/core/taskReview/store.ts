import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { REQUEST_ID, TASK_ID } from "../../shared/refs.ts";
import {
  TASK_REVIEW_STATUSES,
  type TaskReviewInput,
  type TaskReviewListItem,
  type TaskReviewRecord,
  type TaskReviewResult,
  type TaskReviewRun,
  type TaskReviewVerdict,
} from "../../shared/taskReview.ts";
import { dirs, finishRunFile, readJson, ReviewStoreError, runStamp, updateRunFile, writeJson, type RunEnd, type RunStore } from "../reviewRuns.ts";
import { withFileLock } from "../store/fsutil.ts";
import { safeRelPath } from "./paths.ts";

/**
 * タスクの AI レビューの履歴（要望のフォルダの中。要望をアーカイブすれば一緒に動き、タスクをアーカイブしても残る）。
 *
 *   requests/<要望ID>/task-reviews/<タスクID>/<run>/input.json   固定した材料（作ったら変えない）
 *   requests/<要望ID>/task-reviews/<タスクID>/<run>/material/    材料のファイル（差分・前後のコード。作ったら変えない）
 *   requests/<要望ID>/task-reviews/<タスクID>/<run>/run.json     実行の記録
 *   requests/<要望ID>/task-reviews/<タスクID>/<run>/review.json  結果（completed のときだけ。書き終えてから completed にする）
 *   requests/<要望ID>/task-reviews/.locks/<タスクID>.lock        状態を変えるときのロック（プロセス間。タスクごと）
 *
 *   - キーは "<要望ID>/<タスクID>"。ID の形を確かめ、保存先の外を指すものは断る。同じ run は作り直さない
 *   - 保存・終わり・取消の規則はマイルストーンレビューと共通（reviewRuns.ts）
 *   - 結果はタスクのファイル（本文・証拠）には書かない。同じ OS の権限でファイルを直接書き換えることは防がない
 */

export const TASK_REVIEWS_DIR = "task-reviews";
const RUN_ID = /^TR-\d{8}-\d{6}-[0-9a-f]{4}$/;

export function newTaskReviewRunId(now = new Date()): string {
  return `TR-${runStamp(now)}-${randomBytes(2).toString("hex")}`;
}

export function checkTaskReviewRunId(id: string): void {
  if (!RUN_ID.test(id)) throw new ReviewStoreError("bad_id", `タスクのレビューの run の ID ではありません: ${JSON.stringify(id)}（TR-YYYYMMDD-HHMMSS-xxxx）`);
}

/** キー（<要望ID>/<タスクID>）を分けて確かめる */
export function parseTaskReviewKey(key: string): { rid: string; tid: string } {
  const [rid, tid, extra] = key.split("/");
  if (extra !== undefined || !rid || !tid || !REQUEST_ID.test(rid) || !TASK_ID.test(tid)) throw new ReviewStoreError("bad_id", `タスクの参照に使えません: ${JSON.stringify(key)}（<要望ID>/T001）`);
  return { rid, tid };
}

export class TaskReviewStore implements RunStore<TaskReviewRun, TaskReviewResult> {
  /** requestsDir: <data>/requests */
  constructor(readonly requestsDir: string) {}

  private within(...parts: string[]): string {
    const root = resolve(this.requestsDir);
    const p = resolve(root, ...parts);
    if (!p.startsWith(root + sep)) throw new ReviewStoreError("bad_id", `保存先の外を指します: ${parts.join("/")}`);
    return p;
  }

  reviewsDir(rid: string): string {
    parseTaskReviewKey(`${rid}/T001`);
    return this.within(rid, TASK_REVIEWS_DIR);
  }

  taskDir(key: string): string {
    const { rid, tid } = parseTaskReviewKey(key);
    return this.within(rid, TASK_REVIEWS_DIR, tid);
  }

  runDir(key: string, run: string): string {
    checkTaskReviewRunId(run);
    return join(this.taskDir(key), run);
  }

  materialDir(key: string, run: string): string {
    return join(this.runDir(key, run), "material");
  }

  /** タスクの状態を変えるときのロック（ほかのプロセスの開始・終わり・取消と1つずつにする。別のタスクは独立） */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const { rid, tid } = parseTaskReviewKey(key);
    return withFileLock(join(this.reviewsDir(rid), ".locks", `${tid}.lock`), fn, {
      busyMessage: `${key} のレビューの記録を変えられませんでした（別のプロセスが使っています。少し待ってやり直してください）`,
    });
  }

  /** run の ID（新しい順） */
  async runIds(key: string): Promise<string[]> {
    return (await dirs(this.taskDir(key))).filter((r) => RUN_ID.test(r)).sort().reverse();
  }

  async hasHistory(key: string): Promise<boolean> {
    return (await this.runIds(key)).length > 0;
  }

  /** 履歴のあるタスク（アーカイブしたタスクも含む） */
  async tasksWithHistory(rid: string): Promise<string[]> {
    const out: string[] = [];
    for (const d of await dirs(this.reviewsDir(rid))) if (TASK_ID.test(d) && (await this.hasHistory(`${rid}/${d}`))) out.push(d);
    return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  /**
   * 新しい run を作る（材料のファイル・input.json・running の run.json）。同じ ID が既にあれば exists で断る（上書きしない）。
   * 呼ぶ側がロックの中で呼ぶ（同じタスクで実行中の run を2つ作らないため）
   */
  async create(input: TaskReviewInput, files: ReadonlyMap<string, Buffer>, run: TaskReviewRun): Promise<void> {
    const key = `${run.request}/${run.task}`;
    const dir = this.runDir(key, run.id);
    const material = join(dir, "material");
    // 書く前に全部のパスを確かめる（途中で断って作りかけを残さない）
    const targets = [...files].map(([rel, data]) => {
      const path = resolve(material, rel);
      if (!safeRelPath(rel) || !path.startsWith(resolve(material) + sep)) throw new ReviewStoreError("bad_id", `材料のファイルのパスに使えません: ${JSON.stringify(rel)}`);
      return { path, data };
    });
    await mkdir(this.taskDir(key), { recursive: true });
    try {
      await mkdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ReviewStoreError("exists", `既にある run です: ${key}/${run.id}`);
      throw e;
    }
    try {
      for (const { path, data } of targets) {
        await mkdir(dirname(path), { recursive: true });
        // 作ったばかりのフォルダの中だけに書く（途中がシンボリックリンクなら断る。新しいファイルとしてだけ作る）
        await assertNoLinks(material, path);
        await writeFile(path, data, { flag: "wx" });
      }
      await writeJson(join(dir, "input.json"), input);
      await writeJson(join(dir, "run.json"), run);
    } catch (e) {
      // 作りかけの run は残さない（一覧に壊れた記録として出さない）
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  }

  async readRun(key: string, run: string): Promise<TaskReviewRun> {
    return readJson<TaskReviewRun>(join(this.runDir(key, run), "run.json"), `${key}/${run}`, checkRunShape);
  }

  async readInput(key: string, run: string): Promise<TaskReviewInput> {
    return readJson<TaskReviewInput>(join(this.runDir(key, run), "input.json"), `${key}/${run} の input.json`, (x) => {
      const i = x as Partial<TaskReviewInput>;
      if (!i.task || !Array.isArray(i.items) || !Array.isArray(i.targets) || typeof i.hash !== "string") throw new Error("形が違います");
    });
  }

  async readResult(key: string, run: string): Promise<TaskReviewResult> {
    return readJson<TaskReviewResult>(join(this.runDir(key, run), "review.json"), `${key}/${run} の review.json`, (x) => {
      const r = x as Partial<TaskReviewResult>;
      if (typeof r.overall !== "string" || !Array.isArray(r.items)) throw new Error("形が違います");
    });
  }

  /** 1回分（無ければ not_found、どれかが読めなければ broken） */
  async get(key: string, run: string): Promise<TaskReviewRecord> {
    const r = await this.readRun(key, run);
    const input = await this.readInput(key, run);
    const result = r.status === "completed" ? await this.readResult(key, run) : undefined;
    return { run: r, input, ...(result ? { result } : {}) };
  }

  /** 一覧（新しい順）。読めない記録も broken として出す（隠さない） */
  async list(key: string): Promise<TaskReviewListItem[]> {
    const out: TaskReviewListItem[] = [];
    for (const id of await this.runIds(key)) {
      try {
        const rec = await this.get(key, id);
        const verdicts: Partial<Record<TaskReviewVerdict, number>> = {};
        for (const i of rec.result?.items ?? []) verdicts[i.verdict] = (verdicts[i.verdict] ?? 0) + 1;
        out.push({ state: "ok", run: rec.run, inputHash: rec.input.hash, items: rec.input.items.length, ...(rec.result ? { verdicts } : {}) });
      } catch (e) {
        out.push({ state: "broken", id, error: (e as Error).message });
      }
    }
    const at = (x: TaskReviewListItem) => (x.state === "ok" ? x.run.startedAt.replace(/[-:]/g, "").replace("T", "-") : x.id.slice(3, 18));
    return out.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
  }

  async updateRunning(key: string, run: string, fn: (r: TaskReviewRun) => TaskReviewRun): Promise<TaskReviewRun> {
    return updateRunFile(`${key}/${run}`, await this.readRun(key, run), fn, (r) => writeJson(join(this.runDir(key, run), "run.json"), r));
  }

  async finish(key: string, run: string, patch: RunEnd<TaskReviewRun>, result?: TaskReviewResult): Promise<TaskReviewRun> {
    const dir = this.runDir(key, run);
    return finishRunFile(`${key}/${run}`, await this.readRun(key, run), patch, result, {
      writeRun: (r) => writeJson(join(dir, "run.json"), r),
      writeResult: (r) => writeJson(join(dir, "review.json"), r),
    });
  }

  /** 材料のファイルの一覧（材料のフォルダからの相対パス。シンボリックリンクは含めない） */
  async materialFiles(key: string, run: string): Promise<string[]> {
    const root = this.materialDir(key, run);
    const out: string[] = [];
    const walk = async (d: string, rel: string) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(d, e.name), r);
        else if (e.isFile()) out.push(r);
      }
    };
    await walk(root, "");
    return out.sort();
  }
}

/** root から path までの途中（root を除く）にシンボリックリンクが無いこと */
async function assertNoLinks(root: string, path: string): Promise<void> {
  const parts = path.slice(resolve(root).length + 1).split(sep);
  let cur = resolve(root);
  for (const p of parts.slice(0, -1)) {
    cur = join(cur, p);
    if ((await lstat(cur)).isSymbolicLink()) throw new ReviewStoreError("bad_id", `材料のフォルダの中にシンボリックリンクがあります: ${cur}`);
  }
}

function checkRunShape(x: unknown) {
  const r = x as Partial<TaskReviewRun>;
  if (typeof r.id !== "string" || typeof r.request !== "string" || typeof r.task !== "string" || !TASK_REVIEW_STATUSES.includes(r.status as never) || typeof r.startedAt !== "string") {
    throw new Error("形が違います");
  }
  if (!Array.isArray(r.log)) throw new Error("log がありません");
}
