import { describe, expect, it } from "vitest";
import { compareMilestoneIds, sortMilestones } from "../src/shared/milestoneOrder.ts";

const ids = (list: { id: string }[]) => list.map((m) => m.id);
const of = (...xs: string[]) => xs.map((id) => ({ id, title: `t-${id}` }));

describe("マイルストーンの順（ID のバージョンの降順）", () => {
  it("数字の桁を数として比べ、新しいバージョンを先にする（登録の順によらない）", () => {
    const want = ["0.10.0", "0.9.0", "0.4.0", "0.3.1", "0.3.0"];
    for (const shuffled of [["0.3.0", "0.4.0", "0.10.0", "0.3.1", "0.9.0"], ["0.9.0", "0.3.1", "0.3.0", "0.10.0", "0.4.0"], [...want].reverse()]) {
      expect(ids(sortMilestones(of(...shuffled)))).toEqual(want);
    }
  });

  it("先頭の v / V は比べるときだけ外す", () => {
    expect(ids(sortMilestones(of("v1.9", "v2.0", "V1.10")))).toEqual(["v2.0", "V1.10", "v1.9"]);
    expect(ids(sortMilestones(of("v0.2", "0.10")))).toEqual(["0.10", "v0.2"]);
  });

  it("バージョンでない ID も同じ規則で比べる。比べて同じなら元の ID の文字列で決める", () => {
    expect(ids(sortMilestones(of("release-2", "release-10", "beta", "alpha")))).toEqual(["release-10", "release-2", "beta", "alpha"]);
    // 1.0 と v1.0、01.0 は比べると同じ。元の ID で順を決める（どの順で渡しても同じ）
    const same = ["1.0", "v1.0", "01.0"];
    expect(ids(sortMilestones(of(...same)))).toEqual(ids(sortMilestones(of(...[...same].reverse()))));
    expect(ids(sortMilestones(of(...same)))).toEqual(["v1.0", "1.0", "01.0"]);
    expect(compareMilestoneIds("1.0", "1.0")).toBe(0);
    // 続きがあるほうが新しい
    expect(ids(sortMilestones(of("1.0", "1.0.1")))).toEqual(["1.0.1", "1.0"]);
  });

  it("空の配列は空。元の配列は変えない", () => {
    expect(sortMilestones([])).toEqual([]);
    const list = of("0.1", "0.2");
    const sorted = sortMilestones(list);
    expect(ids(list)).toEqual(["0.1", "0.2"]);
    expect(sorted).not.toBe(list);
    expect(sorted[0]).toBe(list[1]); // 要素はそのまま
  });
});
