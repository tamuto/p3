import { describe, expect, it } from "vitest";
import { REQUEST_STATUSES, type GraphEdge, type RequestStatus } from "../src/shared/types.ts";
import { byCheckedDesc } from "../src/web/lib/order.ts";
import { relationItems } from "../src/web/lib/relations.ts";
import { matchesShow, parseShow, SHOW_OPTIONS } from "../src/web/lib/requestFilter.ts";

const pick = (show: Parameters<typeof matchesShow>[1]) => REQUEST_STATUSES.filter((s: RequestStatus) => matchesShow(s, show));

describe("進捗の絞り込み", () => {
  it("ステータスは 進行中 と 完了済 の間に 対応済", () => {
    expect(REQUEST_STATUSES).toEqual(["draft", "preflight", "reviewed", "active", "resolved", "done", "rejected"]);
  });

  it("既定は完了済・見送り以外（対応済を含む）、確認待ちは対応済だけ、閉じたものは対応済を含まない", () => {
    expect(pick("open")).toEqual(["draft", "preflight", "reviewed", "active", "resolved"]);
    expect(pick("resolved")).toEqual(["resolved"]);
    expect(pick("closed")).toEqual(["done", "rejected"]);
    expect(pick("all")).toEqual(REQUEST_STATUSES);
    expect(SHOW_OPTIONS.map(([v]) => v)).toEqual(["open", "resolved", "closed", "all"]);
  });

  it("URL の値: 既定と不正な値は載せない", () => {
    expect(parseShow("resolved")).toBe("resolved");
    expect(parseShow("closed")).toBe("closed");
    expect(parseShow("open")).toBeUndefined();
    expect(parseShow("done")).toBeUndefined();
    expect(parseShow(["all"])).toBeUndefined();
  });
});


describe("対応済みの一覧の並び", () => {
  it("済みにした日時の新しい順。同じ日時ならタスク ID の順（数として比べる）", () => {
    const t = (id: string, checkedAt: string) => ({ id, checkedAt });
    const items = [t("T10", "2026-10-10T00:00:00Z"), t("T2", "2026-10-10T00:00:00Z"), t("T1", "2026-10-09T00:00:00Z"), t("T3", "2026-10-11T00:00:00Z")];
    expect([...items].sort(byCheckedDesc).map((x) => x.id)).toEqual(["T3", "T2", "T10", "T1"]);
    expect([...items].reverse().sort(byCheckedDesc).map((x) => x.id)).toEqual(["T3", "T2", "T10", "T1"]);
  });
});

describe("タスク詳細の関係の行", () => {
  const edge = (from: string, to: string, type: GraphEdge["type"], origin: GraphEdge["origin"] = "human"): GraphEdge => ({ from, to, type, origin });

  it("張った関係は相手の役割（依存先など）で、張られた関係は逆の役割で並べ、消せるのは自分が張ったものだけ", () => {
    const home = "261011-aaaaa";
    const rows = relationItems(
      [edge(`${home}/T002`, `${home}/T001`, "depends_on"), edge(`${home}/T002`, home, "derived_from", "index"), edge(`${home}/T002`, "261011-bbbbb/T004", "impacts", "ai")],
      [edge(`${home}/T005`, `${home}/T002`, "supersedes", "preflight")],
      home,
    );
    expect(rows.map((r) => [r.direction, r.role, r.short, r.removable])).toEqual([
      ["out", "依存先", "T001", true],
      ["out", "派生元", home, false], // 構造から導いた関係は消せない
      ["out", "影響先", "261011-bbbbb/T004", true], // 別の要望は絶対参照のまま
      ["in", "新案", "T005", false], // 張られた関係は相手のファイルにあるので、ここからは消さない
    ]);
    expect(rows.map((r) => r.ref)).toEqual([`${home}/T001`, home, "261011-bbbbb/T004", `${home}/T005`]);
    expect(relationItems([], [], home)).toEqual([]);
  });
});
