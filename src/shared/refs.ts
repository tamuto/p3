/**
 * 参照（要望・タスクの指し方）。
 *
 *   "261009-k7m3x"        要望
 *   "261009-k7m3x/T003"   要望のタスク（絶対参照。プロジェクト全体で一意）
 *   "T003"                同じ要望のタスク（相対参照。ファイルの relations ではこちらを使う）
 */

export const REQUEST_ID = /^\d{6}-[0-9a-z]{5}$/;
export const TASK_ID = /^T\d{3,}$/;

export interface Ref {
  request: string;
  /** タスクなら T003、要望そのものなら undefined */
  task?: string;
}

export function taskId(n: number): string {
  return `T${String(n).padStart(3, "0")}`;
}

/** "T3" / "t003" / "3" をタスク ID（T003）に。違えば undefined */
export function normalizeTaskId(s: string): string | undefined {
  const m = /^t?0*(\d+)$/i.exec(s.trim());
  return m ? taskId(Number(m[1])) : undefined;
}

/** 参照を絶対参照に解く。相対参照（T003）は from の要望の中とみなす */
export function parseRef(target: string, fromRequest?: string): Ref | undefined {
  const [head, tail] = target.split("/", 2);
  if (tail !== undefined) {
    const t = normalizeTaskId(tail);
    return REQUEST_ID.test(head) && t ? { request: head, task: t } : undefined;
  }
  if (REQUEST_ID.test(head)) return { request: head };
  const t = normalizeTaskId(head);
  return t && fromRequest ? { request: fromRequest, task: t } : undefined;
}

export function formatRef(r: Ref): string {
  return r.task ? `${r.request}/${r.task}` : r.request;
}

/** 絶対参照に */
export function absRef(target: string, fromRequest?: string): string | undefined {
  const r = parseRef(target, fromRequest);
  return r && formatRef(r);
}

/** ファイルに書く形に: 同じ要望のタスクなら相対（T003）、それ以外は絶対 */
export function relRef(target: string, fromRequest: string): string | undefined {
  const r = parseRef(target, fromRequest);
  if (!r) return undefined;
  return r.task && r.request === fromRequest ? r.task : formatRef(r);
}
