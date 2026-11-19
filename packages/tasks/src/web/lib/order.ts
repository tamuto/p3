import type { Task } from "../../shared/types.ts";

/** 対応済みの一覧: 済みにした日時の新しい順。同じ日時ならタスク ID の順（T2 < T10） */
export function byCheckedDesc(a: Pick<Task, "id" | "checkedAt">, b: Pick<Task, "id" | "checkedAt">): number {
  return (b.checkedAt ?? "").localeCompare(a.checkedAt ?? "") || a.id.localeCompare(b.id, undefined, { numeric: true });
}
