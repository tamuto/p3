import { readdir, readFile } from "node:fs/promises";
import type { PreflightLogEntry, RunOwner } from "../shared/types.ts";
import { ownerState, systemProbe, type OwnerProbe, type OwnerState } from "./preflight/owner.ts";
import { writeFileAtomic } from "./store/fsutil.ts";

/**
 * レビューの実行の記録の共通部分（マイルストーンレビュー・タスクの AI レビュー）。比較材料と結果の形は各レビューに残し、ここには
 * 「保存の仕方」と「実行中の run の扱い」だけを置く。
 *
 *   - JSON は tmp に書いてから rename する。無いのは not_found、読めないのは broken（一覧からも隠さない）
 *   - 状態は running → completed / failed / cancelled の一方向。終わった run は変えない（finished で断る。遅れて届いた結果も取り込まない）
 *   - 同じ対象（キー）で実行中の run は1つだけ。確かめるのも変えるのもキーごとのロックの中
 *   - 実行しているプロセスが死んだと確かめられた run だけ自動で失敗（crashed）にする。分からない run は人が明示して中断する
 *   - 取消は、このプロセスの run なら止め、ほかのプロセスの run なら要求を run.json に書く（所有者が見つけて止める）
 */

/** 履歴の操作の失敗。not_found: 無い / broken: 読めない / bad_id: ID が使えない / exists: 既にある / finished: 終わった run */
export class ReviewStoreError extends Error {
  constructor(
    readonly code: "not_found" | "broken" | "bad_id" | "exists" | "finished",
    message: string,
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

export async function writeJson(path: string, v: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(v, null, 2)}\n`);
}

export async function readJson<T>(path: string, label: string, check: (x: unknown) => void): Promise<T> {
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

/** フォルダの中のフォルダ（無ければ空。シンボリックリンクは含めない） */
export async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** 開始の日時を run の ID にする形（YYYYMMDD-HHMMSS） */
export const runStamp = (now = new Date()) => now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** 開始の日時（このプロセスでは前より必ず後にする。一覧を開始の順に並べるので、同じミリ秒の開始でも順が分かるように） */
let lastStart = 0;
export function startedNow(): string {
  lastStart = Math.max(Date.now(), lastStart + 1);
  return new Date(lastStart).toISOString();
}

/** 実行の記録に共通の項目 */
export interface RunLike {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  owner?: RunOwner;
  cancelRequested?: { at: string; by?: string };
  abandoned?: { at: string; by?: string };
  failure?: string;
  error?: string;
  finishedAt?: string;
  log: PreflightLogEntry[];
}

export type RunEnd<R extends RunLike> = Partial<R> & { status: Exclude<RunLike["status"], "running"> };

/** run の保存（キーは対象。マイルストーンの ID・<要望>/<タスク> など） */
export interface RunStore<R extends RunLike, Res> {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  runIds(key: string): Promise<string[]>;
  readRun(key: string, run: string): Promise<R>;
  /** 終わりにする（結果があれば書き終えてから）。終わっていれば finished で断る */
  finish(key: string, run: string, patch: RunEnd<R>, result?: Res): Promise<R>;
  updateRunning(key: string, run: string, fn: (r: R) => R): Promise<R>;
}

/**
 * run.json の終わり・書き換えの規則（各ストアの finish / updateRunning の中身）。write は run.json を書く、writeResult は結果を書く
 */
export async function finishRunFile<R extends RunLike, Res>(
  label: string,
  cur: R,
  patch: RunEnd<R>,
  result: Res | undefined,
  io: { writeRun: (r: R) => Promise<void>; writeResult: (r: Res) => Promise<void> },
): Promise<R> {
  if (cur.status !== "running") throw new ReviewStoreError("finished", `${label} は既に終わっています（${cur.status}）`);
  if (patch.status === "completed") {
    if (result === undefined) throw new Error("completed には結果が要ります");
    await io.writeResult(result);
  }
  const next = { ...cur, ...patch, finishedAt: patch.finishedAt ?? new Date().toISOString() } as R;
  await io.writeRun(next);
  return next;
}

export async function updateRunFile<R extends RunLike>(label: string, cur: R, fn: (r: R) => R, writeRun: (r: R) => Promise<void>): Promise<R> {
  if (cur.status !== "running") throw new ReviewStoreError("finished", `${label} は既に終わっています（${cur.status}）`);
  const next = fn(cur);
  await writeRun(next);
  return next;
}

/**
 * 実行中の run の扱い（回復・二重の開始の確かめ・取消・ログの書き足しと取消の要求の見つけ方・終わりの書き方）。
 * local: このプロセスで動いている run の ID
 */
export class RunControl<R extends RunLike, Res> {
  constructor(
    private store: RunStore<R, Res>,
    private local: { has(id: string): boolean },
    private probe: OwnerProbe = systemProbe,
    private onChange: (key: string, r: R) => void = () => undefined,
  ) {}

  ownerOf(r: R): { state: "local" } | OwnerState {
    if (this.local.has(r.id)) return { state: "local" };
    return ownerState(r.owner, this.probe);
  }

  /** 死んだと確かめられた所有者の run を失敗（crashed）にする（ロックの中で呼ぶ） */
  async recoverLocked(key: string): Promise<void> {
    for (const id of await this.store.runIds(key)) {
      const r = await this.store.readRun(key, id).catch(() => undefined);
      if (r?.status !== "running" || this.local.has(r.id)) continue;
      const o = this.ownerOf(r);
      if (o.state !== "dead") continue;
      const fin = await this.store.finish(key, id, { status: "failed", failure: "crashed", error: `実行していたプロセスが途中で終わりました（${o.reason}）` } as RunEnd<R>);
      this.onChange(key, fin);
    }
  }

  /** 実行中の run（回復した後に残るもの。ロックの中で呼ぶ） */
  async runningLocked(key: string): Promise<{ run: R; owner: { state: "local" } | OwnerState } | undefined> {
    await this.recoverLocked(key);
    for (const id of await this.store.runIds(key)) {
      const r = await this.store.readRun(key, id).catch(() => undefined);
      if (r?.status === "running") return { run: r, owner: this.ownerOf(r) };
    }
    return undefined;
  }

  /**
   * 取り消す。このプロセスの run は abortLocal で止め、ほかのプロセスの run は要求を書く。
   * acknowledgeStopped: 人が「実行しているプロセスは止まっている」と確かめた。所有者が分からない run を記録の上で中断にする
   * （動いていると確かめられる所有者がいれば断る。ほかの環境のプロセスを止めたとは限らない）
   */
  async cancel(key: string, run: string, by: string | undefined, opts: { acknowledgeStopped?: boolean; abortLocal?: () => void; label: string }): Promise<{ run: R; requested: boolean }> {
    const isLocal = this.local.has(run);
    const out = await this.store.withLock(key, async () => {
      const cur = await this.store.readRun(key, run);
      if (cur.status !== "running") throw new ReviewCancelRefused("finished", `${opts.label} は既に終わっています（${cur.status}）`);
      const o = this.ownerOf(cur);
      if (opts.acknowledgeStopped && !isLocal) {
        if (o.state === "alive") throw new ReviewCancelRefused("owner_alive", `${opts.label} を実行しているプロセスは動いています。--acknowledge-stopped ではなく取消を使ってください`);
        const fin = await this.store.finish(key, run, {
          status: "cancelled",
          abandoned: { at: new Date().toISOString(), ...(by ? { by } : {}) },
          error: "人が中断しました（ほかの環境で動いているプロセスを止めたとは限りません）",
        } as RunEnd<R>);
        return { run: fin, requested: false };
      }
      if (o.state === "dead") {
        const fin = await this.store.finish(key, run, { status: "failed", failure: "crashed", error: `実行していたプロセスが途中で終わりました（${o.reason}）` } as RunEnd<R>);
        return { run: fin, requested: false };
      }
      const next = await this.store.updateRunning(key, run, (r) => ({ ...r, cancelRequested: { at: new Date().toISOString(), ...(by ? { by } : {}) } }));
      return { run: next, requested: true };
    });
    opts.abortLocal?.();
    this.onChange(key, out.run);
    return out;
  }

  /** ほかのプロセスからの取消の要求を見つけ、ログを run.json に書き足す（止めるときは返した関数を呼ぶ） */
  watch(key: string, run: string, log: readonly PreflightLogEntry[], abort: AbortController, pollMs = 1000): () => void {
    let flushed = 0;
    const timer = setInterval(() => {
      void this.store
        .withLock(key, async () => {
          const cur = await this.store.readRun(key, run);
          if (cur.status !== "running") return abort.abort(new Error("ended"));
          if (cur.cancelRequested) abort.abort(new Error("cancelled"));
          if (log.length !== flushed) {
            flushed = log.length;
            await this.store.updateRunning(key, run, (r) => ({ ...r, log: [...log] }));
          }
        })
        .catch(() => undefined);
    }, pollMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** 終わりを書く（ロックの中で、まだ実行中かを確かめてから）。既に終わっていれば遅れて届いた結果を取り込まず、今の記録を返す */
  async end(key: string, run: string, end: RunEnd<R>, result?: Res): Promise<R> {
    try {
      const fin = await this.store.withLock(key, () => this.store.finish(key, run, end, end.status === "completed" ? result : undefined));
      this.onChange(key, fin);
      return fin;
    } catch (e) {
      if (!(e instanceof ReviewStoreError && e.code === "finished")) throw e;
      const cur = await this.store.readRun(key, run);
      this.onChange(key, cur);
      return cur;
    }
  }
}
