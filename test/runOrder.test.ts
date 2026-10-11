import { describe, expect, it } from "vitest";
import { newestFirst } from "../src/server/store/preflightStore.ts";

const run = (id: string, startedAt: string, previous?: string) => ({ id, startedAt, previous });
const ids = (rs: { id: string }[]) => rs.map((r) => r.id);

describe("run の新しい順", () => {
  it("ふだんは開始時刻の新しい順", () => {
    expect(ids(newestFirst([run("A", "2026-10-11T10:00:00.000Z"), run("C", "2026-10-11T12:00:00.000Z"), run("B", "2026-10-11T11:00:00.000Z")]))).toEqual(["C", "B", "A"]);
  });

  it("時計が戻っても、前回を引き継いだ run は引き継いだ相手より新しい", () => {
    // B は A を引き継いだのに、開始時刻が A より前に記録された（時計の補正で戻った）
    const a = run("PF-1-7220", "2026-10-11T11:49:30.660Z");
    const b = run("PF-1-56e7", "2026-10-11T11:49:30.629Z", "PF-1-7220");
    expect(ids(newestFirst([a, b]))).toEqual(["PF-1-56e7", "PF-1-7220"]);
    // 3つの鎖（C ← B ← A）でも
    const c = run("C", "2026-10-11T11:49:30.100Z", "PF-1-56e7");
    expect(ids(newestFirst([a, c, b]))).toEqual(["C", "PF-1-56e7", "PF-1-7220"]);
  });

  it("引き継いでいない run どうしは時刻順のまま。鎖の位置も時刻で決まる", () => {
    const x = run("X", "2026-10-11T09:00:00.000Z");
    const a = run("A", "2026-10-11T10:00:00.000Z");
    const b = run("B", "2026-10-11T09:30:00.000Z", "A"); // 時計が戻った
    const y = run("Y", "2026-10-11T11:00:00.000Z"); // 失敗などで前回を引き継がなかった、いちばん新しい run
    expect(ids(newestFirst([x, a, b, y]))).toEqual(["Y", "B", "A", "X"]);
  });

  it("無い run を previous に書いていても、循環していても止まる", () => {
    expect(ids(newestFirst([run("A", "2026-10-11T10:00:00.000Z", "gone"), run("B", "2026-10-11T11:00:00.000Z")]))).toEqual(["B", "A"]);
    expect(ids(newestFirst([run("A", "2026-10-11T10:00:00.000Z", "B"), run("B", "2026-10-11T11:00:00.000Z", "A")])).sort()).toEqual(["A", "B"]);
  });
});
