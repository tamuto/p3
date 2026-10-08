import { describe, expect, it } from "vitest";
import { addDays, daysBetween, schedule } from "../src/shared/schedule.ts";
import type { Task } from "../src/shared/types.ts";

const task = (id: string, t: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: "backlog",
  labels: [],
  areas: [],
  relations: [],
  rev: 1,
  createdAt: "",
  updatedAt: "",
  body: "",
  ...t,
});
const dep = (target: string) => ({ type: "depends_on" as const, target });

describe("schedule", () => {
  const today = "2026-10-08";

  it("日付が無ければ今日から見積り日数で置き、依存先の翌日から始める", () => {
    const bars = schedule([task("A", { estimate: 2 }), task("B", { estimate: 1.5, relations: [dep("A")] })], today);
    expect(bars.get("A")).toMatchObject({ start: "2026-10-08", end: "2026-10-09", inferred: true, conflict: false });
    // 1.5 人日は2日に切り上げ
    expect(bars.get("B")).toMatchObject({ start: "2026-10-10", end: "2026-10-11", inferred: true });
  });

  it("明示された日付を優先し、依存先より前に始まっていれば矛盾とする", () => {
    const bars = schedule(
      [task("A", { start: "2026-10-10", due: "2026-10-12" }), task("B", { start: "2026-10-11", relations: [dep("A")] })],
      today,
    );
    expect(bars.get("A")).toMatchObject({ start: "2026-10-10", end: "2026-10-12", inferred: false });
    expect(bars.get("B")?.conflict).toBe(true);
  });

  it("期限だけなら期限から見積りを遡る", () => {
    expect(schedule([task("A", { due: "2026-10-20", estimate: 3 })], today).get("A")).toMatchObject({ start: "2026-10-18", end: "2026-10-20" });
  });

  it("depends_on 以外の関係と、存在しない依存先はスケジュールに効かない", () => {
    const bars = schedule(
      [task("A", { estimate: 5 }), task("B", { relations: [{ type: "impacts", target: "A" }, dep("TASK-404")] })],
      today,
    );
    expect(bars.get("B")?.start).toBe(today);
  });

  it("依存が循環していても止まらない", () => {
    const bars = schedule([task("A", { relations: [dep("B")] }), task("B", { relations: [dep("A")] })], today);
    expect(bars.size).toBe(2);
  });

  it("日付の計算", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-10-01", "2026-10-08")).toBe(7);
  });
});
