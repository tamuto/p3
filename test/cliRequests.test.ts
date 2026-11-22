// CLI を別のプロセスで動かして確かめる: 要望の表示と管理（show --brief・対応済・マイルストーン・親子）。
// 共通の準備（CLI の呼び出し・テストごとの個人設定・初期化済みのプロジェクト）は cliHelpers.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { p3, initialized, relate } from "./cliHelpers.ts";

describe("show --brief（作業に要る項目だけ）", () => {
  /**
   * T001 done・T002 doing（← T001）・T003 todo（← T002・別の要望のタスク・別の要望・アーカイブした T004）、
   * T005 に以前の版が書いた置き換え（supersedes）の関係がある（今は使わない）
   */
  async function prepared() {
    const { root, rid } = await initialized();
    const other = p3(root, ["request", "new", "別の要望", "--json"]).json().id as string;
    p3(root, ["new", "別の要望のタスク", "--req", other]);
    for (const t of ["下準備", "本体", "仕上げ", "消す予定", "新しい方式"]) p3(root, ["new", t, "--req", rid, "--body", `${t}の作業内容\n\n## 完了条件\n- できる`]);
    p3(root, ["move", "T001", "done", "--req", rid, "--output", "https://example.com/pull/1"]);
    p3(root, ["move", "T002", "doing", "--req", rid]);
    relate(root, rid, "T002", [{ type: "depends_on", target: "T001" }]);
    relate(root, rid, "T003", [{ type: "depends_on", target: "T002" }, { type: "depends_on", target: "T004" }]);
    relate(root, rid, "T005", [{ type: "supersedes", target: "T001", note: "新しい方式に替える" }]);
    p3(root, ["archive", "T004", "--req", rid]);
    return { root, rid, other };
  }

  it("タスク: 本文・依存とその状態（見つからないものは null）・成果物・rev を残し、ほかを省く", async () => {
    const { root, rid } = await prepared();
    const full = p3(root, ["show", "T003", "--req", rid, "--json"]).json();
    const brief = p3(root, ["show", "T003", "--req", rid, "--brief", "--json"]);
    expect(brief.code, brief.err).toBe(0);
    const b = brief.json();
    expect(Object.keys(b)).toEqual(["item", "work", "dependencies"]);
    expect(b.work).toMatchObject({ repo: "app", registered: true }); // 作業先にできる参照先が1つなので、それ
    expect(Object.keys(b.item)).toEqual(["id", "ref", "request", "title", "status", "body", "rev", "outputs", "relations"]);
    for (const k of Object.keys(b.item)) if (k !== "relations") expect(b.item[k]).toEqual(full.item[k]);
    expect(b.item.body).toContain("## 完了条件");
    // 依存だけ。type / target は元のまま
    expect(b.item.relations.map((r: any) => [r.type, r.target])).toEqual([
      ["depends_on", "T002"],
      ["depends_on", "T004"],
    ]);
    const deps = [
      { ref: `${rid}/T002`, title: "本体", status: "doing" },
      { ref: `${rid}/T004`, title: null, status: null }, // アーカイブした: 状態不明（完了とは扱わない）
    ];
    expect(b.dependencies).toEqual(deps);
    expect(full.dependencies).toEqual(deps); // 通常の --json にも同じ項目
    expect(b).not.toHaveProperty("graph");
    expect(b).not.toHaveProperty("file");
    expect(b.item).not.toHaveProperty("createdAt");

    const text = p3(root, ["show", "T003", "--req", rid, "--brief"]).out;
    expect(text).toContain("依存    T002 doing / T004 （状態不明）");
    expect(text).toContain("仕上げの作業内容");
    expect(text).not.toContain("関係しそう");
    expect(text).not.toContain("影響範囲");
    expect(text).not.toContain("ファイル:");
    expect(text.length).toBeLessThan(p3(root, ["show", "T003", "--req", rid]).out.length);

    // 依存なし・完了・成果物
    const done = p3(root, ["show", "T001", "--req", rid, "--brief", "--json"]).json();
    expect(done.item).toMatchObject({ status: "done", outputs: ["https://example.com/pull/1"], relations: [] });
    expect(done.dependencies).toEqual([]);
  });

  it("以前の置き換えの関係はファイルに残っても、通常・短い出力に出さない（印・警告も無い）", async () => {
    const { root, rid } = await prepared();
    for (const extra of [[], ["--brief"]]) {
      const j = p3(root, ["show", "T001", "--req", rid, ...extra, "--json"]).json();
      expect(j).not.toHaveProperty("superseded");
      expect(j).not.toHaveProperty("warnings");
    }
    expect(p3(root, ["show", "T005", "--req", rid, "--json"]).json().item.relations).toEqual([]);
    expect(p3(root, ["show", "T001", "--req", rid, "--brief"]).out).not.toContain("置き換え");
  });

  it("要望: 本文・状態・ブランチ・タスクの一覧（id・ref・title・status）と issue。show <要望> と request show は同じ", async () => {
    const { root, rid } = await prepared();
    // 未完了のタスクがあるのに対応済（ファイルを人が直したなど。CLI からはこの状態にできない）
    const reqFile = join(root, ".p3", "requests", rid, "request.md");
    writeFileSync(reqFile, readFileSync(reqFile, "utf8").replace(/^status: \w+$/m, "status: resolved"));
    const full = p3(root, ["request", "show", rid, "--json"]).json();
    const b = p3(root, ["request", "show", rid, "--brief", "--json"]).json();
    expect(Object.keys(b)).toEqual(["item", "branches", "tasks", "issue", "parent", "ancestors", "children", "hierarchyIssues"]);
    expect(Object.keys(b.item)).toEqual(["id", "title", "status", "body", "rev", "workstreams"]); // タスクを足したときに作業先のブランチを割り当てている
    for (const k of Object.keys(b.item)) expect(b.item[k]).toEqual(full.item[k]);
    expect(b.tasks).toEqual(full.tasks.map((t: any) => ({ id: t.id, ref: t.ref, title: t.title, status: t.status, repo: "app" })));
    expect(b.issue).toBe(full.issue);
    expect(p3(root, ["show", rid, "--brief", "--json"]).json()).toEqual(b);
    // 今の要望を省略しても同じ
    expect(p3(root, ["request", "show", "--req", rid, "--brief", "--json"]).json()).toEqual(b);
    const text = p3(root, ["request", "show", rid, "--brief"]).out;
    expect(text).toMatch(/^※ 対応済ですが/);
    expect(text).toContain("タスク (4):");
    expect(text).not.toContain("関係:");
  });

  it("ブランチのある要望は作業先ごとのブランチを残し、曖昧な指定・見つからない指定は今までどおり", async () => {
    const { root, rid } = await initialized();
    p3(root, ["preflight", rid, "--engine", "mock"]);
    p3(root, ["accept", rid]);
    const b = p3(root, ["request", "show", rid, "--brief", "--json"]).json();
    expect(b.item.workstreams.app.branch).toMatch(/^req\//);
    expect(b.branches).toEqual(b.item.workstreams);
    expect(p3(root, ["request", "show", rid, "--brief"]).out).toContain(`branch  app: ${b.item.workstreams.app.branch}`);
    expect(p3(root, ["show", "存在しない語句", "--brief"]).code).toBe(2);
  });
});

describe("要望の対応済", () => {
  it("全タスクを完了したら対応済にでき、未完了のタスクができたら進行中に戻す", async () => {
    const { root, rid } = await initialized();
    p3(root, ["preflight", rid, "--engine", "mock"]);
    p3(root, ["accept", rid]);
    const ng = p3(root, ["request", "set", rid, "status=resolved"]);
    expect(ng.code).toBe(1);
    expect(ng.err).toContain("完了していないタスクがあります: T001(todo), T002(todo), T003(todo)");
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");

    for (const t of ["T001", "T002", "T003"]) p3(root, ["move", t, "done", "--req", rid]);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active"); // 自動では対応済にしない
    const ok = p3(root, ["request", "set", rid, "status=resolved", "--json"], { P3_ACTOR: "ai:claude" });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.json()).toMatchObject({ status: "resolved", updatedBy: "ai:claude" });
    expect(p3(root, ["request", "ls", "--status", "resolved", "--json"]).json().map((r: any) => r.id)).toEqual([rid]);
    expect(p3(root, ["progress"]).out).toContain("resolved"); // 既定の一覧に残る（確認待ち）

    const back = p3(root, ["move", "T002", "doing", "--req", rid, "--json"]);
    expect(back.err).toContain("進行中に戻しました");
    expect(back.json().reopened).toBe(rid);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");
  });
});

describe("p3 milestone と要望の管理項目", () => {
  it("マイルストーンを作り、要望に期限・マイルストーン・タグを付け、進捗をマイルストーンごとにまとめる", async () => {
    const { root, rid } = await initialized();
    expect(p3(root, ["milestone", "add", "v0.2", "--title", "要望単位の運用", "--due", "2026-11-30"]).code).toBe(0);
    expect(p3(root, ["milestone", "add", "v0.2"]).err).toContain("既にあります");
    expect(p3(root, ["request", "set", rid, "milestone=nope"]).err).toContain("マイルストーンがありません");
    expect(p3(root, ["request", "set", rid, "milestone=v0.2", "due=2026-11-15", "tags=ui,feature"]).code).toBe(0);
    const other = p3(root, ["request", "new", "別の要望", "--tag", "bug", "--json"]).json();
    expect(other.tags).toEqual(["bug"]);
    expect(p3(root, ["request", "ls", "--milestone", "v0.2", "--json"]).json().map((r: any) => r.id)).toEqual([rid]);
    expect(p3(root, ["request", "ls", "--tag", "bug", "--json"]).json().map((r: any) => r.id)).toEqual([other.id]);
    const text = p3(root, ["progress"]).out;
    expect(text).toContain("■ 要望単位の運用（v0.2 · 2026-11-30）");
    expect(text).toContain("■ マイルストーンなし");
    expect(p3(root, ["milestone", "rm", "v0.2"]).err).toContain("使用中のマイルストーンは消せません");
    expect(p3(root, ["milestone", "set", "v0.2", "--done"]).code).toBe(0);
    expect(p3(root, ["milestone", "--json"]).json()).toEqual([{ id: "v0.2", title: "要望単位の運用", due: "2026-11-30", done: true }]);
  });

  it("一覧・進捗・概要はマイルストーンを ID のバージョンの降順に出す（project.yaml の順は変えない）", async () => {
    const { root, rid } = await initialized();
    for (const id of ["v0.9", "v0.10", "v0.2"]) expect(p3(root, ["milestone", "add", id, "--title", `題 ${id}`]).code).toBe(0);
    const yaml = readFileSync(join(root, ".p3", "project.yaml"), "utf8");
    expect(p3(root, ["milestone", "--json"]).json().map((m: any) => m.id)).toEqual(["v0.10", "v0.9", "v0.2"]);
    const ls = p3(root, ["milestone"]).out;
    expect(ls.indexOf("v0.10")).toBeLessThan(ls.indexOf("v0.9"));
    expect(ls.indexOf("v0.9")).toBeLessThan(ls.indexOf("v0.2"));
    expect(p3(root, ["config"]).out).toContain("milestones     v0.10, v0.9, v0.2");
    // 進捗のまとまりも同じ順。マイルストーンなしは最後
    expect(p3(root, ["request", "set", rid, "milestone=v0.2"]).code).toBe(0);
    const b = p3(root, ["request", "new", "十", "--milestone", "v0.10", "--json"]).json();
    p3(root, ["request", "new", "なし", "--json"]);
    const text = p3(root, ["progress"]).out;
    const pos = ["（v0.10", "（v0.2", "マイルストーンなし"].map((h) => text.indexOf(h));
    expect(pos.every((x) => x >= 0), text).toBe(true);
    expect([...pos].sort((x, y) => x - y)).toEqual(pos);
    expect(b.milestone).toBe("v0.10");
    // 表示だけでは project.yaml を書き換えない（登録の順のまま）
    expect(readFileSync(join(root, ".p3", "project.yaml"), "utf8")).toBe(yaml);
    expect(yaml.indexOf("v0.9")).toBeLessThan(yaml.indexOf("v0.10"));
  });
});

describe("p3 request の親子", () => {
  it("--parent で子を作り、ls --parent・show --brief --json で親子を読み、parent= で外す。規則に合わなければ 1", async () => {
    const { root, rid } = await initialized();
    const child = p3(root, ["request", "new", "送信基盤", "--parent", rid.slice(-5), "--json"]); // 短い書き方でもよい
    expect(child.code, child.err).toBe(0);
    const cid = child.json().id as string;
    expect(child.json().parent).toBe(rid);
    expect(p3(root, ["request", "ls", "--parent", rid, "--json"]).json().map((r: { id: string }) => r.id)).toEqual([cid]);
    const brief = p3(root, ["request", "show", rid, "--brief", "--json"]).json();
    expect(brief.children).toEqual([{ id: cid, title: "送信基盤", status: "draft", tasks: { total: 0, done: 0 } }]);
    expect(p3(root, ["request", "show", cid, "--brief", "--json"]).json()).toMatchObject({ parent: rid, ancestors: [{ id: rid }], item: { parent: rid } });
    expect(p3(root, ["request", "show", rid]).out).toContain("子の要望 (1、表示順。実行の順ではない)");
    // 循環・アーカイブ（子がある）は同じ規則で断る
    const cycle = p3(root, ["request", "set", rid, `parent=${cid}`]);
    expect(cycle.code).toBe(1);
    expect(cycle.err).toContain("循環");
    const arch = p3(root, ["request", "archive", rid]);
    expect(arch.code).toBe(1);
    expect(arch.err).toContain(cid);
    const freed = p3(root, ["request", "set", cid, "parent=", "--json"]);
    expect(freed.code, freed.err).toBe(0);
    expect(freed.json().parent).toBeUndefined();
  });
});
