import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  confirmTarget,
  currentTarget,
  readRetrospective,
  retroCandidates,
  RetrospectiveError,
  type RetroCandidate,
  type RetrospectiveFile,
  type RetroTarget,
} from "../shared/retrospective.ts";
import type { P3Context } from "./context.ts";
import { listArchivedTasks } from "./store/archivedTasks.ts";
import { NotFoundError } from "./store/collection.ts";
import { withFileLock, writeFileAtomic } from "./store/fsutil.ts";

/**
 * 要望の振り返りの保存と読み取り（規則は shared/retrospective.ts）。記録は requests/<要望ID>/retrospective.json で、要望のロック
 * （requestLock。要望・タスクの保存と同じ）の中で、読み直してから版を照らして書く。読み取りはファイルを書かない
 */

export const RETRO_FILE = "retrospective.json";

const pathOf = (ctx: P3Context, rid: string) => join(ctx.ws.requestsDir, rid, RETRO_FILE);

/** 記録を読む（無ければ空。壊れていれば retro_unreadable） */
export async function loadRetrospective(ctx: P3Context, rid: string): Promise<RetrospectiveFile> {
  let text: string;
  try {
    text = await readFile(pathOf(ctx, rid), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 0, targets: [] };
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new RetrospectiveError("retro_unreadable", `retrospective.json が JSON として読めません: ${(e as Error).message}（ファイルを直してください）`);
  }
  return readRetrospective(raw);
}

/** 候補（新しい順）。runs と照らすタスク・子の要望はディスクと読み込んだ値から */
export async function retrospectiveCandidates(ctx: P3Context, rid: string): Promise<{ candidates: RetroCandidate[]; none?: string; runs: Awaited<ReturnType<typeof ctx.preflight.list>> }> {
  const request = ctx.ws.requests.require(rid);
  const runs = await ctx.preflight.list(rid);
  const archived = new Set((await listArchivedTasks(ctx.ws, rid)).tasks.map((t) => t.id));
  const tasks = ctx.ws.tasksOf(rid);
  const lookup = {
    task: (tid: string) => (tasks.get(tid) ? ("present" as const) : archived.has(tid) ? ("archived" as const) : ("missing" as const)),
    child: (id: string) => {
      const c = ctx.ws.requests.get(id);
      return c ? { splitFrom: c.splitFrom, parent: c.parent } : undefined;
    },
  };
  return { ...retroCandidates(rid, request.status, runs, lookup), runs };
}

export interface RetrospectiveView {
  version: number;
  /** 今の対象（無ければ未確定） */
  target?: RetroTarget;
  /** 確定と訂正の履歴（古い順） */
  targets: RetroTarget[];
  candidates: RetroCandidate[];
  /** 候補が無い理由 */
  none?: string;
}

export async function retrospectiveView(ctx: P3Context, rid: string): Promise<RetrospectiveView> {
  const file = await loadRetrospective(ctx, rid);
  const { candidates, none } = await retrospectiveCandidates(ctx, rid);
  const target = currentTarget(file);
  return { version: file.version, ...(target ? { target } : {}), targets: file.targets, candidates, ...(none ? { none } : {}) };
}

/**
 * 振り返りの対象を確定する（訂正は理由つきで追記）。expectedVersion が今の版と違えば retro_conflict、候補でない・評価が無いなどは
 * retro_invalid（どちらも何も書かない）
 */
export async function confirmRetrospectiveTarget(
  ctx: P3Context,
  rid: string,
  input: { run: string; reason?: string },
  opts: { expectedVersion?: number; actor?: string } = {},
): Promise<RetrospectiveView> {
  ctx.ws.requests.require(rid);
  await withFileLock(
    ctx.ws.requestLock(rid),
    async () => {
      // ロックの中で要望があることを確かめる（アーカイブで移した後のフォルダに書き戻さない）
      if ("missing" in (await ctx.ws.requests.peek(rid))) throw new NotFoundError(rid);
      const file = await loadRetrospective(ctx, rid);
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== file.version) {
        throw new RetrospectiveError("retro_conflict", `振り返りの記録が他で変わりました（版 ${opts.expectedVersion} → ${file.version}）。読み直してからやり直してください`);
      }
      const { candidates, none, runs } = await retrospectiveCandidates(ctx, rid);
      const runOf = (id: string) => runs.find((r) => r.id === id);
      const next = confirmTarget(file, input, {
        candidates,
        none,
        risksOf: (id) => runOf(id)?.assessment?.risks,
        assessmentOf: (id) => runOf(id)?.assessment,
        now: new Date().toISOString(),
        actor: opts.actor,
      });
      await writeFileAtomic(pathOf(ctx, rid), `${JSON.stringify(next, null, 2)}\n`);
    },
    { busyMessage: "別のプロセスがこの要望を保存中です。少し待ってやり直してください" },
  );
  ctx.ws.emit({ type: "changed", kind: "request", request: rid });
  return retrospectiveView(ctx, rid);
}
