import { describe, expect, it } from "vitest";
import {
  bucketStart,
  centerDate,
  daysBetween,
  groupMarks,
  leftWidth,
  nextBucket,
  PX_PER_DAY,
  scheduleSpan,
  scrollLeftFor,
  ticks,
  timeRange,
  visibleRows,
  ZOOMS,
} from "../src/web/lib/timeline.ts";

describe("timeline", () => {
  it("まとまりの最初の日: 週は月曜、月は1日", () => {
    expect(bucketStart("2026-10-09", "day")).toBe("2026-10-09");
    expect(bucketStart("2026-10-09", "week")).toBe("2026-10-05"); // 金曜 → その週の月曜
    expect(bucketStart("2026-10-11", "week")).toBe("2026-10-05"); // 日曜も同じ週
    expect(bucketStart("2026-10-09", "month")).toBe("2026-10-01");
    expect(nextBucket("2026-12-01", "month")).toBe("2027-01-01");
  });

  it("期間に上限はなく、データのある全期間をまとまりの境目にそろえて描く", () => {
    const r = timeRange(["2025-01-15", "2027-03-01"], "2026-10-09", "month");
    expect(r.from <= "2025-01-15" && r.from.endsWith("-01")).toBe(true);
    expect(r.to >= "2027-03-01").toBe(true);
    const w = timeRange(["2026-10-09"], "2026-10-09", "week");
    expect(new Date(`${w.from}T00:00:00Z`).getUTCDay()).toBe(1); // 月曜から
  });

  it("見えている範囲の目盛りだけを作る（2年分でも画面1枚分）", () => {
    const range = timeRange(["2024-10-01", "2026-12-31"], "2026-10-09", "day");
    const all = ticks(range, "day", "2026-10-09", 0, 10_000_000);
    expect(all.length).toBeGreaterThan(800);
    expect(all.at(-1)!.start).toBe(range.to); // 期間の終わりで止まる
    const visible = ticks(range, "day", "2026-10-09", 15_000, 16_200);
    expect(visible.length).toBeLessThanOrEqual(41);
    expect(visible[0].x).toBeGreaterThanOrEqual(15_000 - PX_PER_DAY.day);
    expect(visible.length).toBeGreaterThan(35);
    // 今日の目盛りと月の切り替わり
    expect(all.find((k) => k.today)?.start).toBe("2026-10-09");
    expect(all.find((k) => k.start === "2026-11-01")?.group).toBe("11月");
    const months = ticks(range, "month", "2026-10-09", 0, 1e9);
    expect(months.find((k) => k.start === "2026-01-01")?.group).toBe("2026年");
  });

  it("印をまとまりごと・種類ごとにまとめる", () => {
    const g = groupMarks(
      [
        { date: "2026-10-05", kind: "done", item: "a" },
        { date: "2026-10-09", kind: "done", item: "b" },
        { date: "2026-10-09", kind: "doing", item: "c" },
      ],
      "week",
    );
    expect(g).toEqual([
      { start: "2026-10-05", kind: "doing", items: ["c"] },
      { start: "2026-10-05", kind: "done", items: ["a", "b"] },
    ]);
    expect(groupMarks([{ date: "2026-10-05", kind: "done", item: "a" }], "day")[0].start).toBe("2026-10-05");
  });

  it("見えている行だけを描く", () => {
    expect(visibleRows(0, 600, 64, 52, 1000)).toEqual({ first: 0, last: 15 });
    const mid = visibleRows(52_000, 600, 64, 52, 1000);
    expect(mid.first).toBeGreaterThan(990 - 20);
    expect(mid.last).toBe(1000);
  });
});

describe("狭い画面の表示幅", () => {
  it("広い画面は 380px のまま、狭い画面は縮める。境目は 640px", () => {
    expect(leftWidth(1280)).toBe(380);
    expect(leftWidth(640)).toBe(380);
    expect(leftWidth(639)).toBe(230);
    expect(leftWidth(375)).toBe(135);
    expect(leftWidth(200)).toBe(112); // 下限
    expect(leftWidth(0)).toBe(380); // 測る前
  });

  it("スケジュールの見える幅はいつも正（測る前は 0）", () => {
    expect(scheduleSpan(1280)).toBe(900);
    expect(scheduleSpan(640)).toBe(260);
    expect(scheduleSpan(639)).toBe(409);
    expect(scheduleSpan(375)).toBe(240);
    expect(scheduleSpan(0)).toBe(0);
    for (let w = 1; w <= 2000; w += 7) expect(scheduleSpan(w), `${w}px`).toBeGreaterThanOrEqual(0);
    for (const w of [320, 375, 639, 640, 1280]) expect(scheduleSpan(w), `${w}px`).toBeGreaterThan(0);
  });

  it("今日への移動とズームの中央は同じ見える幅で計算し、中央の日付が保たれる", () => {
    const from = "2026-01-05";
    for (const w of [375, 639, 640, 1280]) {
      for (const zoom of ZOOMS) {
        const px = PX_PER_DAY[zoom];
        const d = "2026-06-15";
        const left = scrollLeftFor(d, from, px, w, 0.5);
        expect(centerDate(left, from, px, w), `${w}px ${zoom}`).toBe(d);
        // 今日（0.4 の位置）は見える範囲の中にある
        const todayLeft = scrollLeftFor(d, from, px, w, 0.4);
        const xd = daysBetween(from, d) * px;
        expect(xd - todayLeft).toBeGreaterThanOrEqual(0);
        expect(xd - todayLeft).toBeLessThan(scheduleSpan(w));
      }
    }
    expect(scrollLeftFor(from, from, 30, 375, 0.4)).toBe(0); // 左端より前にはしない
  });

  it("見える範囲の目盛りを描く（375px でも見える幅を覆う）", () => {
    const range = { from: "2026-01-05", to: "2026-12-28" };
    for (const zoom of ZOOMS) {
      const px = PX_PER_DAY[zoom];
      const left = scrollLeftFor("2026-06-15", range.from, px, 375, 0.4);
      const t = ticks(range, zoom, "2026-06-15", left, left + scheduleSpan(375));
      expect(t.length, zoom).toBeGreaterThan(0);
      expect(t[0].x).toBeLessThanOrEqual(left);
      expect(t.at(-1)!.x + t.at(-1)!.width).toBeGreaterThanOrEqual(left + scheduleSpan(375));
    }
  });
});
