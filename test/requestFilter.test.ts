import { describe, expect, it } from "vitest";
import { REQUEST_STATUSES, type GraphEdge, type RequestStatus } from "../src/shared/types.ts";
import { byCheckedDesc } from "../src/web/lib/order.ts";
import { relationItems } from "../src/web/lib/relations.ts";
import { filterRequests, matchesShow, parseShow, parseTagsSearch, SHOW_OPTIONS, tagCandidates, toggleTag, type Show } from "../src/web/lib/requestFilter.ts";

const pick = (show: Parameters<typeof matchesShow>[1]) => REQUEST_STATUSES.filter((s: RequestStatus) => matchesShow(s, show));

describe("進捗の絞り込み", () => {
  it("ステータスは 進行中 と 完了済 の間に 対応済", () => {
    expect(REQUEST_STATUSES).toEqual(["draft", "preflight", "reviewed", "active", "resolved", "done", "rejected"]);
  });

  it("未完了は作業の残るものだけ（対応済を含まない）、確認待ちは対応済だけ、閉じたものは完了済・見送りだけ", () => {
    expect(pick("open")).toEqual(["draft", "preflight", "reviewed", "active"]);
    expect(pick("resolved")).toEqual(["resolved"]);
    expect(pick("closed")).toEqual(["done", "rejected"]);
    expect(pick("all")).toEqual(REQUEST_STATUSES);
    expect(SHOW_OPTIONS.map(([v]) => v)).toEqual(["open", "resolved", "closed", "all"]);
  });

  it("7 つの状態 × 4 つの絞り込み", () => {
    const table: Record<RequestStatus, Record<Show, boolean>> = {
      draft: { open: true, resolved: false, closed: false, all: true },
      preflight: { open: true, resolved: false, closed: false, all: true },
      reviewed: { open: true, resolved: false, closed: false, all: true },
      active: { open: true, resolved: false, closed: false, all: true },
      resolved: { open: false, resolved: true, closed: false, all: true },
      done: { open: false, resolved: false, closed: true, all: true },
      rejected: { open: false, resolved: false, closed: true, all: true },
    };
    for (const status of REQUEST_STATUSES)
      for (const [show] of SHOW_OPTIONS) expect([status, show, matchesShow(status, show)]).toEqual([status, show, table[status][show]]);
  });

  it("URL の値: 既定と不正な値は載せない", () => {
    expect(parseShow("resolved")).toBe("resolved");
    expect(parseShow("closed")).toBe("closed");
    expect(parseShow("open")).toBeUndefined();
    expect(parseShow("done")).toBeUndefined();
    expect(parseShow(["all"])).toBeUndefined();
  });

  it("行の絞り込み: URL の省略・open・不正な値はどれも既定（未完了）になり、対応済は入らない。タグと併せても同じ", () => {
    const row = (id: string, status: RequestStatus, tags: string[] = []) => ({ id, request: { status, tags } });
    const items = REQUEST_STATUSES.flatMap((s) => [row(`${s}-a`, s, ["a"]), row(`${s}-b`, s, ["b"])]);
    const ids = (show?: Show, tag?: string) => filterRequests(items, show, tag ? [tag] : []).map((p) => p.id);
    const open = ["draft-a", "draft-b", "preflight-a", "preflight-b", "reviewed-a", "reviewed-b", "active-a", "active-b"];
    expect(ids()).toEqual(open);
    expect(ids(parseShow(undefined))).toEqual(open);
    expect(ids(parseShow("open"))).toEqual(open);
    expect(ids(parseShow("bogus"))).toEqual(open);
    expect(ids("open", "a")).toEqual(["draft-a", "preflight-a", "reviewed-a", "active-a"]);
    expect(ids("resolved", "a")).toEqual(["resolved-a"]);
    expect(ids("closed", "b")).toEqual(["done-b", "rejected-b"]);
    expect(ids("all", "a")).toEqual(REQUEST_STATUSES.map((s) => `${s}-a`));
    expect(ids("open", "none")).toEqual([]);
  });
});


describe("タグの複数選択", () => {
  const row = (id: string, status: RequestStatus, tags: string[]) => ({ id, request: { status, tags } });
  const items = [
    row("j1", "active", ["jira:PROJ-1", "group:顧客A"]),
    row("j2", "draft", ["jira:PROJ-2"]),
    row("g", "resolved", ["group:顧客A"]),
    row("c", "done", ["a,b", "Group:顧客A"]),
    row("n", "active", []),
  ];
  const ids = (show: Show, tags: string[]) => filterRequests(items, show, tags).map((p) => p.id);

  it("未選択は絞らない。選んだ中はどれか（OR）、状態とはかつ（AND）。完全一致（大小文字を区別）", () => {
    expect(ids("all", [])).toEqual(["j1", "j2", "g", "c", "n"]);
    expect(ids("all", ["group:顧客A"])).toEqual(["j1", "g"]);
    expect(ids("all", ["jira:PROJ-2", "a,b"])).toEqual(["j2", "c"]);
    expect(ids("open", ["group:顧客A"])).toEqual(["j1"]); // 未完了から対応済を除く
    expect(ids("resolved", ["group:顧客A", "jira:PROJ-1"])).toEqual(["g"]);
    expect(ids("closed", ["group:顧客A"])).toEqual([]); // 大小文字が違う
    expect(ids("all", ["jira"])).toEqual([]); // 部分一致では絞らない
    expect(ids("all", ["無いタグ"])).toEqual([]);
    expect(ids("all", ["group:顧客A", "group:顧客A"])).toEqual(["j1", "g"]);
  });

  it("候補はすべての状態の要望から（数つき、名前の順）。検索は部分一致で大小文字を区別しない", () => {
    expect(tagCandidates(items)).toEqual([
      { tag: "a,b", count: 1 },
      { tag: "group:顧客A", count: 2 },
      { tag: "Group:顧客A", count: 1 },
      { tag: "jira:PROJ-1", count: 1 },
      { tag: "jira:PROJ-2", count: 1 },
    ].sort((x, y) => x.tag.localeCompare(y.tag, "ja")));
    expect(tagCandidates(items, " GROUP ").map((c) => c.tag).sort()).toEqual(["Group:顧客A", "group:顧客A"].sort());
    expect(tagCandidates(items, "proj-").map((c) => c.tag)).toEqual(["jira:PROJ-1", "jira:PROJ-2"]);
    expect(tagCandidates(items, "無い")).toEqual([]);
    // 要望が消えたら候補からも消える（選択は呼ぶ側に残る）
    expect(tagCandidates(items.filter((p) => p.id !== "c")).map((c) => c.tag)).not.toContain("a,b");
    expect(toggleTag(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleTag(["a", "b"], "a")).toEqual(["b"]);
  });

  it("URL: ?tags= の配列を読み、以前の ?tag= は1つ選んだものとして読む。不正な値は捨て、重複はまとめる", () => {
    expect(parseTagsSearch(["jira:PROJ-1", "a,b", "記号 & ? # / %"])).toEqual(["jira:PROJ-1", "a,b", "記号 & ? # / %"]);
    expect(parseTagsSearch(undefined, "feature")).toEqual(["feature"]);
    expect(parseTagsSearch(undefined, 123)).toEqual(["123"]); // 以前の URL の数に見える値
    expect(parseTagsSearch(["x"], "legacy")).toEqual(["x"]); // tags を優先
    expect(parseTagsSearch(["x", "x", "", 1, null, ["y"], "y"])).toEqual(["x", "y"]);
    expect(parseTagsSearch("not-array")).toBeUndefined();
    expect(parseTagsSearch(undefined, "")).toBeUndefined();
    expect(parseTagsSearch([])).toBeUndefined();
    expect(parseTagsSearch(undefined)).toBeUndefined();
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
