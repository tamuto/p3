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
    expect(accepted).toMatchObject({ archived: [], kept: [] });
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

describe("置き換えられたタスク", () => {
  /** 初回のタスク化（T001〜T003）の後に再評価し、新しい案 D1 が T001・T002 を、D2 が T003 を置き換えると書かれた状態を作る */
  async function reassessed() {
    const { root, rid } = await initialized();
    p3(root, ["preflight", rid, "--engine", "mock"]);
    p3(root, ["accept", rid]);
    p3(root, ["move", "T002", "doing", "--req", rid]);
    const run = p3(root, ["preflight", rid, "--engine", "mock", "--json"]).json();
    expect(run, JSON.stringify({ status: run.status, error: run.error, log: run.log?.slice(-3) })).toMatchObject({ status: "completed" });
    const dir = join(root, ".p3", "requests", rid, "preflight", run.id);
    const d1 = join(dir, "drafts", "D1.md");
    writeFileSync(d1, readFileSync(d1, "utf8").replace("include: true", "supersedes: [T001, T002]\ninclude: true"));
    const d2 = join(dir, "drafts", "D2.md");
    writeFileSync(d2, readFileSync(d2, "utf8").replace("include: true", "supersedes: [T003]\ninclude: true"));
    return { root, rid };
  }

  it("タスク化の前に候補を見せ、フラグが無ければ残して印を付け、着手すると警告する", async () => {
    const { root, rid } = await reassessed();
    expect(p3(root, ["drafts", rid, "--json"]).json().supersedes.map((c: any) => [c.id, c.status])).toEqual([
      ["T001", "todo"],
      ["T002", "doing"],
      ["T003", "todo"],
    ]);
    // D2・D3 を外すと、D1 の置き換えだけが残る
    const accepted = p3(root, ["accept", rid, "--only", "D1"]);
    expect(accepted.code, accepted.err).toBe(0);
    expect(accepted.out).toContain("置き換えられるタスクを残しました");
    const ls = p3(root, ["ls", "--req", rid, "--json"]).json();
    expect(ls.map((t: any) => [t.id, (t.superseded ?? []).map((m: any) => m.from)])).toEqual([
      ["T001", [`${rid}/T004`]],
      ["T002", [`${rid}/T004`]],
      ["T003", []], // 不採用の D2 にだけあった
      ["T004", []],
    ]);
    expect(p3(root, ["ls", "--req", rid]).out).toMatch(/T001 .*※置換 ← T004/);
    expect(p3(root, ["ls", "--all"]).out).toContain("※置換");
    expect(p3(root, ["show", "T003", "--req", rid]).out).not.toContain("※ 置き換えられています");
    expect(p3(root, ["show", "T001", "--req", rid, "--json"]).json().superseded).toEqual([{ from: `${rid}/T004` }]);

    // 着手は止めずに警告する。--json の stdout は JSON のまま、warnings で返す
    const moved = p3(root, ["move", "T001", "doing", "--req", rid, "--json"]);
    expect(moved.code).toBe(0);
    expect(moved.err).toContain("警告: ");
    expect(moved.json()).toMatchObject({ status: "doing", warnings: [{ code: "superseded", target: `${rid}/T001`, from: [`${rid}/T004`] }] });
    // 作業中のままの再指定や、置き換えられていないタスクでは出さない
    expect(p3(root, ["move", "T001", "doing", "--req", rid, "--json"]).json().warnings).toBeUndefined();
    expect(p3(root, ["move", "T004", "doing", "--req", rid]).err).not.toContain("警告");
    expect(p3(root, ["set", "T002", "status=todo", "--req", rid]).err).not.toContain("警告");
    expect(p3(root, ["set", "T002", "status=doing", "--req", rid]).err).toContain("警告");
  });

  it("--archive-superseded で確定時点の候補をアーカイブする", async () => {
    const { root, rid } = await reassessed();
    const r = p3(root, ["accept", rid, "--only", "d1", "--archive-superseded", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(r.json()).toMatchObject({ tasks: [{ id: "T004" }], archived: ["T001", "T002"], kept: [] });
    expect(p3(root, ["ls", "--req", rid, "--json"]).json().map((t: any) => t.id)).toEqual(["T003", "T004"]);
    // 最大番号をアーカイブしても番号は再利用しない
    p3(root, ["archive", "T004", "--req", rid]);
    expect(p3(root, ["new", "次の作業", "--req", rid, "--json"]).json().id).toBe("T005");
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
