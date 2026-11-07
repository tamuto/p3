import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { REQUEST_ID, TASK_ID, taskId } from "../../shared/refs.ts";
import type { ArchivedTask, ArchivedTaskError, ArchivedTaskList, Task } from "../../shared/types.ts";
import { fileLayout, MarkdownCollection, NotFoundError } from "./collection.ts";
import { normalizeTaskIn, TASK_KEY_ORDER } from "./normalize.ts";
import type { Workspace } from "./workspace.ts";

/**
 * アーカイブしたタスク（requests/<要望ID>/tasks/.archive/<ID>.md）を読むだけの道。
 *
 *   - 通常のタスクのコレクション（Workspace.tasksOf）・索引・変更通知には触れない。読むたびにディスクを読み、キャッシュしない
 *   - ファイル・rev・状態・採番の予約（collection.ts の reserved）を変えない
 *   - 明示した要望の中だけを読む。要望 ID・タスク ID の形を確かめ、ほかの場所は読ませない
 *   - 通常の一覧・進捗・対応済の判定・依存・レビューやリリースノートの材料はこれを使わない（docs/architecture.md「アーカイブしたタスク」）
 */

/** アーカイブのフォルダかファイルを読めない（無いのではない） */
export class ArchivedTaskReadError extends Error {
  readonly code = "archive_unreadable";
}

/** 要望が無ければ NotFoundError。読めない要望（壊れた request.md）でもアーカイブは読める */
function requestDir(ws: Workspace, rid: string): string {
  if (!REQUEST_ID.test(rid) || (!ws.requests.get(rid) && !ws.requests.errors.has(rid))) throw new NotFoundError(rid);
  return join(ws.requestsDir, rid, "tasks", ".archive");
}

function reader(ws: Workspace, rid: string) {
  return new MarkdownCollection<Task>({
    layout: fileLayout(requestDir(ws, rid), TASK_ID, taskId),
    normalize: normalizeTaskIn(rid),
    keyOrder: TASK_KEY_ORDER,
    derived: ["request", "ref"],
  });
}

const mark = (t: Task): ArchivedTask => ({ ...t, archived: true });

/** 要望のアーカイブの一覧（ID の数値順）。フォルダが無ければ空。フォルダを読めなければ ArchivedTaskReadError */
export async function listArchivedTasks(ws: Workspace, rid: string): Promise<ArchivedTaskList> {
  const dir = requestDir(ws, rid);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { request: rid, tasks: [], errors: [] };
    throw new ArchivedTaskReadError(`${rid} のアーカイブを読めません: ${(e as Error).message}`);
  }
  const ids = names
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .filter((id) => TASK_ID.test(id))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const col = reader(ws, rid);
  const tasks: ArchivedTask[] = [];
  const errors: ArchivedTaskError[] = [];
  for (const id of ids) {
    const r = await col.peek(id);
    if ("item" in r) tasks.push(mark(r.item));
    else if ("error" in r) errors.push({ id, error: r.error });
    // 一覧を作る間に消えたものは出さない
  }
  return { request: rid, tasks, errors };
}

/** アーカイブの1件。無ければ NotFoundError（<要望ID>/<ID>）、読めなければ ArchivedTaskReadError */
export async function getArchivedTask(ws: Workspace, rid: string, tid: string): Promise<ArchivedTask> {
  const col = reader(ws, rid);
  if (!TASK_ID.test(tid)) throw new NotFoundError(`${rid}/${tid}`);
  const r = await col.peek(tid);
  if ("item" in r) return mark(r.item);
  if ("missing" in r) throw new NotFoundError(`${rid}/${tid}`);
  throw new ArchivedTaskReadError(`${rid}/${tid} のアーカイブを読めません: ${r.error}`);
}
