// CLI を別のプロセスで動かして確かめる: Preflight（Mock）・drafts・accept・メモ・置き換え・調べた範囲・子の要望の案。
// 共通の準備（CLI の呼び出し・テストごとの個人設定・初期化済みのプロジェクト）は cliHelpers.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_HOME, p3, initialized } from "./cliHelpers.ts";
import { tempDir } from "./helpers.ts";

describe("p3 preflight / drafts / accept", () => {
  it("mock エンジンで評価し、一部を除いてタスク化する", async () => {
    const { root, rid } = await initialized();
    const run = p3(root, ["preflight", rid, "--engine", "mock", "--json"]);
    expect(run.code, run.err).toBe(0);
    expect(run.json()).toMatchObject({ status: "completed", engine: "mock" });
    expect(p3(root, ["drafts", rid]).out).toContain("D3");

    const accepted = p3(root, ["accept", rid, "--skip", "d3", "--json"]).json();
    expect(Object.keys(accepted)).toEqual(["tasks"]);
    expect(accepted.tasks.map((t: any) => [t.id, t.title])).toEqual([
      ["T001", "送信基盤"],
      ["T002", "設定画面"],
    ]);
    expect(accepted.tasks[1].relations).toEqual([expect.objectContaining({ type: "depends_on", target: "T001" })]);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");
  });

  it("評価のあとで本文を変えると accept は断り（--json で理由）、再評価すればタスク化できる", async () => {
    const { root, rid } = await initialized();
    expect(p3(root, ["preflight", rid, "--engine", "mock"]).code).toBe(0);
    const rev = p3(root, ["request", "show", rid, "--brief", "--json"]).json().item.rev;
    const set = p3(root, ["request", "set", rid, "--body", "-", "--rev", String(rev), "--json"], {}, CONFIG_HOME, "- 送信基盤\n- 再送\n");
    expect(set.code, set.err).toBe(0);
    expect(set.json().body).toContain("- 再送");
    // 古い rev では保存しない
    expect(p3(root, ["request", "set", rid, "--body", "x", "--rev", String(rev)]).code).toBe(3);

    expect(p3(root, ["drafts", rid]).out).toContain("古い評価からはタスク化しません");
    expect(p3(root, ["drafts", rid, "--json"]).json().inputMatch).toEqual({ status: "changed", changed: ["body"] });
    const json = p3(root, ["accept", rid, "--json"]);
    expect(json.code).toBe(1);
    expect(json.json()).toMatchObject({ code: "stale_input", request: rid, inputMatch: { status: "changed", changed: ["body"] } });
    const human = p3(root, ["accept", rid]);
    expect(human.code).toBe(1);
    expect(human.err).toContain(`p3 preflight ${rid}`);
    expect(p3(root, ["ls", "--req", rid, "--json"]).json()).toEqual([]);

    expect(p3(root, ["preflight", rid, "--engine", "mock"]).code).toBe(0);
    const ok = p3(root, ["accept", rid, "--json"]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.json().tasks.map((t: any) => t.title)).toEqual(["送信基盤", "再送"]);
  });
});

describe("p3 preflight --note / notes", () => {
  it("メモだけ書き足し、一覧で渡すものを確かめ、次の Preflight で引き継ぐ", async () => {
    const { root, rid } = await initialized();
    expect(p3(root, ["preflight", rid, "--note-only"]).err).toContain("--note");
    expect(p3(root, ["preflight", rid, "--note", " ", "--note-only"]).err).toContain("空");
    const first = p3(root, ["preflight", rid, "--engine", "mock", "--json"]).json();

    const note = p3(root, ["preflight", rid, "--note", "- 再送は不要", "--note-only", "--json"], { P3_ACTOR: "human:a" });
    expect(note.code, note.err).toBe(0);
    expect(note.json()).toMatchObject({ body: "- 再送は不要", createdBy: "human:a" });
    const notes = p3(root, ["notes", rid, "--json"]).json();
    expect(notes).toMatchObject({ previous: first.id, notes: [{ id: note.json().id, pending: true }] });
    expect(p3(root, ["notes", rid]).out).toContain(`前回 ${first.id} を引き継ぐ・メモ 1 件を渡す`);

    const second = p3(root, ["preflight", rid, "--engine", "mock", "--note", "設定画面は後回し"]);
    expect(second.code, second.err).toBe(0);
    expect(second.err).toContain("を書き足しました");
    expect(second.out).toContain(`引き継ぎ: 前回 ${first.id} / メモ `);
    expect(p3(root, ["notes", rid, "--json"]).json().notes.map((n: any) => n.pending)).toEqual([false, false]);
  });
});

describe("以前の置き換え（supersedes）の記録", () => {
  it("--archive-superseded は何も変えずに断り、ファイルに残る置き換えの関係と案の項目は、表示せず、関係のない編集でも消えない", async () => {
    const { root, rid } = await initialized();
    p3(root, ["preflight", rid, "--engine", "mock"]);
    const run = p3(root, ["drafts", rid, "--json"]).json();
    // 以前の版が書いた案の supersedes
    const d1 = join(root, ".p3", "requests", rid, "preflight", run.id, "drafts", "D1.md");
    writeFileSync(d1, readFileSync(d1, "utf8").replace("include: true", "supersedes: [T009]\ninclude: true"));
    const refused = p3(root, ["accept", rid, "--archive-superseded"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--archive-superseded はなくなりました");
    expect(p3(root, ["ls", "--req", rid, "--json"]).json()).toEqual([]);
    expect(p3(root, ["drafts", rid, "--json"]).json().drafts[0]).not.toHaveProperty("supersedes");
    expect(p3(root, ["drafts", rid, "--json"]).json()).not.toHaveProperty("supersedes");
    // 案を直しても、ファイルの supersedes は残る
    expect(p3(root, ["criteria", "D1", "--req", rid, "--run", run.id, "add", "追加の基準"]).code).toBe(0);
    expect(readFileSync(d1, "utf8")).toContain("supersedes:");
    const accepted = p3(root, ["accept", rid, "--json"]);
    expect(accepted.code, accepted.err).toBe(0);
    expect(accepted.json()).not.toHaveProperty("archived");
    expect(accepted.json().tasks[0].relations).toEqual([]);

    // 以前の版が書いたタスクの置き換えの関係
    const t2 = join(root, ".p3", "requests", rid, "tasks", "T002.md");
    writeFileSync(t2, readFileSync(t2, "utf8").replace(/relations:[^\n]*\n(  - [^\n]*\n(    [^\n]*\n)*)*/, "relations:\n  - type: depends_on\n    target: T001\n    origin: preflight\n  - type: supersedes\n    target: T001\n    origin: preflight\n"));
    const shown = p3(root, ["show", `${rid}/T002`, "--json"]).json();
    expect(shown.item.relations).toEqual([{ type: "depends_on", target: "T001", origin: "preflight" }]);
    expect(shown).not.toHaveProperty("superseded");
    expect(p3(root, ["move", "T001", "doing", "--req", rid, "--json"]).json()).not.toHaveProperty("warnings");
    expect(p3(root, ["move", "T002", "doing", "--req", rid]).code).toBe(0);
    expect(readFileSync(t2, "utf8")).toContain("type: supersedes");
  });
});

describe("Preflight の調べた範囲と根拠（p3 drafts）", () => {
  it("登録から Preflight（Mock）・drafts まで: 読んだ参照先・見ていない参照先・推測の根拠を出し、JSON にもある", async () => {
    const { root, rid } = await initialized();
    const docs = tempDir("docs-");
    expect(p3(root, ["repo", "add", "docs", docs, "role=ドキュメント"]).code).toBe(0);
    expect(p3(root, ["repo", "add", "infra", "role=基盤"]).code).toBe(0); // このマシンのパスなし
    const pf = p3(root, ["preflight", rid, "--engine", "mock"]);
    expect(pf.code, pf.err).toBe(0);
    const text = p3(root, ["drafts", rid]).out;
    expect(text).toContain("調べた範囲:");
    expect(text).toContain("✓ app（本体）  /workspace/app");
    expect(text).toContain("✕ infra（基盤）  このマシンのパスが登録されていません（p3 repo path infra <パス>）");
    expect(text).toContain("判断の根拠:");
    expect(text).toContain("推測      mock: 要望の本文の箇条書きからタスク案を作った（コードは読んでいない）");
    expect(text).toContain("→ このマシンのパスは p3 repo path <名前> <パス> で登録します");
    const json = p3(root, ["drafts", rid, "--json"]).json();
    expect(json.scope.map((s: any) => [s.name, s.status])).toEqual([["app", "ok"], ["docs", "ok"], ["infra", "unregistered"]]);
    expect(JSON.stringify(json.scope)).not.toContain(root); // このマシンのパスは入れない
    expect(json.assessment.evidence[0].kind).toBe("assumed");
  });
});

describe("p3 accept（子の要望の案）", () => {
  it("分割の run は drafts で子の案と分割の判断を見せ、accept で子の要望を作る（--skip で外す）", async () => {
    const { root } = await initialized();
    const big = p3(root, ["request", "new", "大きい要望", "--body", Array.from({ length: 9 }, (_, i) => `- 項目${i + 1}`).join("\n"), "--json"]).json();
    const pf = p3(root, ["preflight", big.id, "--engine", "mock", "--json"]);
    expect(pf.code, pf.err).toBe(0);
    const shown = p3(root, ["drafts", big.id]);
    expect(shown.out).toContain("分割: 子の要望に分ける（想定 8 件）"); // Mock は箇条書きを 8 件まで読む
    expect(shown.out).toContain("子の要望の案 (3/3 件を採用)");
    const r = p3(root, ["accept", big.id, "--skip", "C3", "--json"]);
    expect(r.code, r.err).toBe(0);
    const made = r.json();
    expect(made.created.map((c: { key: string }) => c.key)).toEqual(["C1", "C2"]);
    expect(p3(root, ["request", "ls", "--parent", big.id, "--json"]).json()).toHaveLength(2);
    expect(p3(root, ["accept", big.id]).code).toBe(1); // 済んだ採用はやり直さない
  });
});
