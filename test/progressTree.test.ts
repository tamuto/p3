import { describe, expect, it } from "vitest";
import { parentChoices, progressTree } from "../src/web/lib/progressTree.ts";
import type { RequestProgress } from "../src/shared/types.ts";

/** 進捗の親子の木と、親に選べる要望（web/lib/progressTree.ts） */
const row = (id: string, parent?: string): RequestProgress => ({
    request: { id, title: id, status: "active", parent, areas: [], tags: [], rev: 1, createdAt: "", updatedAt: "", body: "" },
    tasks: [],
    counts: { todo: 0, doing: 0, done: 0 },
    total: 0,
    done: 0,
    updatedAt: "",
    children: [],
    subtree: { counts: { todo: 0, doing: 0, done: 0 }, total: 0, done: 0, requests: { draft: 0, preflight: 0, reviewed: 0, active: 0, resolved: 0, done: 0, rejected: 0 } },
    hierarchyIssues: [],
  });
const shape = (rows: ReturnType<typeof progressTree>) => rows.map((r) => `${"  ".repeat(r.depth)}${r.p.request.id}${r.context ? "（文脈）" : ""}${r.hasChildren ? (r.collapsed ? " ▸" : " ▾") : ""}`);

describe("進捗の親子の木", () => {
  it("子を親の下に並べ、多段にし、畳んだ親の子孫は出さない", () => {
    const all = [row("a"), row("b", "a"), row("c", "b"), row("d")];
    expect(shape(progressTree(all, all, new Set()))).toEqual(["a ▾", "  b ▾", "    c", "d"]);
    expect(shape(progressTree(all, all, new Set(["a"])))).toEqual(["a ▸", "d"]);
  });

  it("絞り込みで子だけが合うと、祖先を文脈として出す（合ったものだけを数える）", () => {
    const all = [row("a"), row("b", "a"), row("c", "b"), row("d")];
    const rows = progressTree(all, [all[2], all[3]], new Set());
    expect(shape(rows)).toEqual(["a（文脈） ▾", "  b（文脈） ▾", "    c", "d"]);
    expect(rows.filter((r) => !r.context)).toHaveLength(2);
  });

  it("親が一覧に無い子・循環している要望は根に出し、止まる", () => {
    const all = [row("x", "gone"), row("p", "q"), row("q", "p")];
    expect(shape(progressTree(all, all, new Set())).sort()).toEqual(["p", "q", "x"]);
  });

  it("親に選べるのは自分と子孫以外", () => {
    const all = [row("a"), row("b", "a"), row("c", "b"), row("d")].map((r) => r.request);
    expect(parentChoices(all, "b").map((r) => r.id)).toEqual(["a", "d"]);
    expect(parentChoices(all).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });
});
