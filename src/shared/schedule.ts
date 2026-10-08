import type { Task } from "./types.ts";

export interface ScheduledBar {
  id: string;
  start: string;
  end: string;
  /** 日付が明示されているか、依存と見積りから推定したか */
  inferred: boolean;
  /** 依存先の終了より前に開始している */
  conflict: boolean;
}

const DAY = 86_400_000;
const toTime = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDate = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * ガントチャート用のスケジュール計算。
 *  - start/due があればそれを使う
 *  - 無ければ depends_on の終了後（無ければ today）から1日で前詰め（見積りは持たない。期間は日付で表す）
 * depends_on 以外の関係（impacts, relates_to 等）はスケジュール制約にしない。
 */
export function schedule(tasks: Task[], today: string): Map<string, ScheduledBar> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Map<string, ScheduledBar>();
  const visiting = new Set<string>();

  const deps = (t: Task) => t.relations.filter((r) => r.type === "depends_on" && byId.has(r.target)).map((r) => r.target);

  const visit = (t: Task): ScheduledBar => {
    const done = out.get(t.id);
    if (done) return done;
    if (visiting.has(t.id)) return { id: t.id, start: today, end: today, inferred: true, conflict: true }; // 循環
    visiting.add(t.id);
    const depEnd = Math.max(toTime(today) - DAY, ...deps(t).map((d) => toTime(visit(byId.get(d)!).end)));
    const dur = 1;
    let start: number;
    let end: number;
    if (t.start) {
      start = toTime(t.start);
      end = t.due ? toTime(t.due) : start + (dur - 1) * DAY;
    } else if (t.due) {
      end = toTime(t.due);
      start = end - (dur - 1) * DAY;
    } else {
      start = depEnd + DAY;
      end = start + (dur - 1) * DAY;
    }
    const explicitDeps = deps(t).map((d) => toTime(visit(byId.get(d)!).end));
    const bar: ScheduledBar = {
      id: t.id,
      start: toDate(start),
      end: toDate(Math.max(start, end)),
      inferred: !t.start && !t.due,
      conflict: explicitDeps.some((e) => e >= start),
    };
    visiting.delete(t.id);
    out.set(t.id, bar);
    return bar;
  };
  for (const t of tasks) visit(t);
  return out;
}

/** 今日（ローカル時刻の日付。UTC だと日本の朝は前日になる） */
export function localToday(now = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
}

export function daysBetween(a: string, b: string) {
  return Math.round((toTime(b) - toTime(a)) / DAY);
}

export function addDays(d: string, n: number) {
  return toDate(toTime(d) + n * DAY);
}
