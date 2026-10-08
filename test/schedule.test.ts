import { describe, expect, it } from "vitest";
import { addDays, daysBetween, schedule } from "../src/shared/schedule.ts";
import type { Task } from "../src/shared/types.ts";

const task = (id: string, t: Partial<Task> = {}): Task => ({
  id,
  request: "261009-abcde",
  ref: `261009-abcde/${id}`,
  title: id,
  status: "todo",
  labels: [],
  areas: [],
  outputs: [],
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

  it("日付が無ければ今日から1日で置き、依存先の翌日から始める（見積りは持たない）", () => {
    const bars = schedule([task("A"), task("B", { relations: [dep("A")] }), task("C", { relations: [dep("B")] })], today);
    expect(bars.get("A")).toMatchObject({ start: "2026-10-08", end: "2026-10-08", inferred: true, conflict: false });
    expect(bars.get("B")).toMatchObject({ start: "2026-10-09", end: "2026-10-09", inferred: true });
    expect(bars.get("C")?.start).toBe("2026-10-10");
  });

  it("明示された日付を優先し、依存先より前に始まっていれば矛盾とする", () => {
    const bars = schedule(
      [task("A", { start: "2026-10-10", due: "2026-10-12" }), task("B", { start: "2026-10-11", relations: [dep("A")] })],
      today,
    );
    expect(bars.get("A")).toMatchObject({ start: "2026-10-10", end: "2026-10-12", inferred: false });
    expect(bars.get("B")?.conflict).toBe(true);
  });

  it("期限だけならその日1日、開始だけならその日1日", () => {
    expect(schedule([task("A", { due: "2026-10-20" })], today).get("A")).toMatchObject({ start: "2026-10-20", end: "2026-10-20" });
    expect(schedule([task("A", { start: "2026-10-12" })], today).get("A")).toMatchObject({ start: "2026-10-12", end: "2026-10-12" });
  });

  it("depends_on 以外の関係と、要望の外・存在しない依存先はスケジュールに効かない", () => {
    const bars = schedule(
      [task("A", { start: "2026-10-20", due: "2026-10-25" }), task("B", { relations: [{ type: "impacts", target: "A" }, dep("T404"), dep("261001-other/T001")] })],
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
