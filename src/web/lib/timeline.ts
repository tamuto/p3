/**
 * 進捗のスケジュールの計算（描画から切り離した純粋な関数）。
 *
 * 期間に上限は設けず、データのある全期間を描く。描画するのは見えている範囲だけ（仮想スクロール）なので、
 * 1年・2年と運用して横に長くなっても、描く要素の数は画面1枚分で変わらない。
 * ズーム（日 / 週 / 月）で1日あたりの幅を変え、週・月では同じ週・月の印をまとめる。
 */

export type Zoom = "day" | "week" | "month";
export const ZOOMS: Zoom[] = ["day", "week", "month"];

/** 1日あたりの幅（px） */
export const PX_PER_DAY: Record<Zoom, number> = { day: 30, week: 10, month: 3 };

const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(t(d) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((t(b) - t(a)) / DAY);
export const weekday = (d: string) => new Date(t(d)).getUTCDay();

/** 日付が属するまとまりの最初の日（日: その日 / 週: その週の月曜 / 月: その月の1日） */
export function bucketStart(d: string, zoom: Zoom): string {
  if (zoom === "day") return d;
  if (zoom === "week") return addDays(d, -((weekday(d) + 6) % 7));
  return `${d.slice(0, 8)}01`;
}

/** まとまりの次の最初の日 */
export function nextBucket(d: string, zoom: Zoom): string {
  if (zoom === "day") return addDays(d, 1);
  if (zoom === "week") return addDays(d, 7);
  const [y, m] = d.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/**
 * 描く期間。データのある全期間（最初の出来事・今日 から 最後の期限・マイルストーン・今日 まで）に、
 * ズームに応じた余白を付ける。両端はまとまりの境目にそろえる。
 */
export function timeRange(dates: string[], today: string, zoom: Zoom): { from: string; to: string } {
  const all = [today, ...dates].sort();
  const pad = { day: 7, week: 21, month: 60 }[zoom];
  const from = bucketStart(addDays(all[0], -pad), zoom);
  let to = addDays(all.at(-1)!, pad);
  to = addDays(nextBucket(bucketStart(to, zoom), zoom), -1);
  return { from, to };
}

export interface Tick {
  /** まとまりの最初の日 */
  start: string;
  /** 左端からの位置と幅（px） */
  x: number;
  width: number;
  /** 下段のラベル（日 / 週の月曜の日付 / 月） */
  label: string;
  /** 上段のラベル（月や年が変わるところだけ） */
  group?: string;
  /** 土日（日のズームだけ） */
  weekend: boolean;
  /** 今日を含む */
  today: boolean;
}

/** 見えている範囲 [fromX, toX) の目盛りだけを作る（期間の終わり range.to より先は作らない） */
export function ticks(range: { from: string; to: string }, zoom: Zoom, today: string, fromX: number, toX: number): Tick[] {
  const px = PX_PER_DAY[zoom];
  const out: Tick[] = [];
  const firstDay = Math.max(0, Math.floor(fromX / px));
  let d = bucketStart(addDays(range.from, firstDay), zoom);
  if (d < range.from) d = range.from;
  for (let i = 0; i < 2000; i++) {
    const x = daysBetween(range.from, d) * px;
    if (x >= toX || d > range.to) break;
    const next = nextBucket(d, zoom);
    const width = daysBetween(d, next) * px;
    const [y, m, day] = d.split("-").map(Number);
    const prevMonth = addDays(d, -1).slice(0, 7);
    out.push({
      start: d,
      x,
      width,
      label: zoom === "day" ? String(day) : zoom === "week" ? `${m}/${day}` : `${m}月`,
      group:
        zoom === "month"
          ? m === 1 || out.length === 0
            ? `${y}年`
            : undefined
          : prevMonth !== d.slice(0, 7) || out.length === 0
            ? zoom === "day"
              ? `${m}月`
              : `${y}/${m}`
            : undefined,
      weekend: zoom === "day" && (weekday(d) === 0 || weekday(d) === 6),
      today: d <= today && today < next,
    });
    d = next;
  }
  return out;
}

/** 印を、ズームのまとまりごと・種類ごとにまとめる */
export function groupMarks<T>(marks: { date: string; kind: string; item: T }[], zoom: Zoom): { start: string; kind: string; items: T[] }[] {
  const map = new Map<string, { start: string; kind: string; items: T[] }>();
  for (const m of marks) {
    const start = bucketStart(m.date, zoom);
    const key = `${start}|${m.kind}`;
    (map.get(key) ?? map.set(key, { start, kind: m.kind, items: [] }).get(key)!).items.push(m.item);
  }
  return [...map.values()].sort((a, b) => a.start.localeCompare(b.start) || a.kind.localeCompare(b.kind));
}

/** 見えている行の範囲（前後に少し余分に描く） */
export function visibleRows(scrollTop: number, viewHeight: number, headH: number, rowH: number, count: number, overscan = 4) {
  const first = Math.max(0, Math.floor((scrollTop - headH) / rowH) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + viewHeight - headH) / rowH) + overscan);
  return { first, last };
}
