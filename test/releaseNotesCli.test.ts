import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { gitInit, tempDir } from "./helpers.ts";

/** p3 release-notes を別プロセスで動かす（個人設定はテストごとに分け、このマシンの P3_* は効かせない） */
const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
let CONFIG_HOME = "";
beforeEach(() => {
  CONFIG_HOME = tempDir("p3-config-");
});

function env() {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
  return { ...base, XDG_CONFIG_HOME: CONFIG_HOME, P3_ACTOR: "human:tester" };
}

function p3(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", input, env: env() });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

/** マイルストーン v1 に、収録する要望（記録つき）と未完了の要望。v2 は要望なし */
function setup() {
  const root = tempDir("p3-rn-");
  gitInit(root);
  expect(p3(root, ["init", "--yes", "--dir", ".p3", "--repo-name", "app"]).code).toBe(0);
  p3(root, ["milestone", "add", "v1", "--title", "最初のリリース"]);
  p3(root, ["milestone", "add", "v2", "--title", "次"]);
  const a = p3(root, ["request", "new", "検索", "--milestone", "v1", "--json"]).json().id as string;
  expect(p3(root, ["new", "索引を作る", "--req", a]).code).toBe(0);
  expect(p3(root, ["move", "T001", "done", "--req", a, "--record", "検索の索引を足した"]).code).toBe(0);
  expect(p3(root, ["request", "set", a, "status=resolved"]).code).toBe(0);
  const b = p3(root, ["request", "new", "途中", "--milestone", "v1", "--json"]).json().id as string;
  return { root, a, b, file: join(root, ".p3", "release-notes", "v1.md") };
}

describe("p3 release-notes", () => {
  it("一覧・対象の要望と警告・生成の案（保存しない）・保存・版による更新・本文だけの出力", () => {
    const { root, a, b, file } = setup();
    const ls = p3(root, ["release-notes", "--json"]).json();
    expect(ls.milestones.map((m: any) => [m.milestone, m.requests, m.note.state])).toEqual([
      // 登録の順（v1, v2）ではなく、ID のバージョンの降順
      ["v2", 0, "none"],
      ["v1", 2, "none"],
    ]);

    const show = p3(root, ["release-notes", "show", "v1", "--json"]).json();
    expect(show.note).toBeNull();
    expect(show.material.requests.map((r: any) => [r.id, r.included, r.reason ?? ""])).toEqual([
      [a, true, ""],
      [b, false, "未完了（draft）"],
    ]);
    expect(show.material.requests[1].warnings.map((w: any) => [w.code, w.target])).toEqual([["not_finished", b]]);
    expect(p3(root, ["release-notes", "show", "v1"]).out).toContain("未完了（draft）");

    // 生成の案: stdout は本文の案だけ、出典と進み具合は stderr。保存しない
    const gen = p3(root, ["release-notes", "generate", "v1", "--engine", "mock"]);
    expect(gen.code, gen.err).toBe(0);
    expect(gen.out).toBe("## 最初のリリース\n\n- （Mock）検索: 検索の索引を足した\n");
    expect(gen.err).toContain(`1. ${a}, ${a}/T001`);
    expect(gen.err).toContain("保存はしていません");
    expect(existsSync(file)).toBe(false);
    const genJson = p3(root, ["release-notes", "generate", "v1", "--engine", "mock", "--json"]).json();
    expect(genJson).toMatchObject({ status: "completed", engine: "mock", milestone: "v1", items: [{ sources: [a, `${a}/T001`] }] });
    expect(genJson.materialHash).toBe(show.material.hash);

    // 新規保存（ファイルから）
    const draft = join(root, "draft.md");
    writeFileSync(draft, "## 最初のリリース\n\n- 検索が速くなった\n");
    const saved = p3(root, ["release-notes", "save", "v1", "--file", draft, "--based-on", genJson.materialHash, "--json"]);
    expect(saved.code, saved.err).toBe(0);
    expect(saved.json().warnings).toEqual([]);
    const v1 = saved.json().note.version as string;
    // 既にあるノートは版なしでは上書きしない
    const dup = p3(root, ["release-notes", "save", "v1", "--body", "上書き"]);
    expect(dup.code).toBe(3);
    expect(dup.err).toContain("既にあります");

    // 版を付けて標準入力から更新。古い版は競合
    const upd = p3(root, ["release-notes", "save", "v1", "--body", "-", "--version", v1, "--json"], "## 最初のリリース\n\n- 検索と一覧が速くなった\n");
    expect(upd.code, upd.err).toBe(0);
    const stale = p3(root, ["release-notes", "save", "v1", "--body", "古い版から", "--version", v1]);
    expect(stale.code).toBe(3);
    expect(stale.err).toContain("競合");

    // 出力は本文だけ。出力・生成・表示では保存したファイルは変わらない
    const before = readFileSync(file, "utf8");
    const exp = p3(root, ["release-notes", "export", "v1"]);
    expect(exp.out).toBe("## 最初のリリース\n\n- 検索と一覧が速くなった\n");
    expect(exp.out).not.toContain("検索の索引を足した");
    expect(before).toContain("record: 検索の索引を足した");
    p3(root, ["release-notes", "generate", "v1", "--engine", "mock"]);
    p3(root, ["release-notes", "show", "v1"]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(p3(root, ["release-notes", "show", "v1", "--json"]).json()).toMatchObject({ materialChanged: false, note: { updatedBy: "human:tester" } });
  });

  it("要望の一括完了: show で判定と hash を見て、complete-requests で対応済を完了済にする（タスクの済みは変えない）", () => {
    const { root, a, b } = setup();
    // 未完了（b）がある: できない。hash が合っていても何も変えずに非ゼロ
    const d1 = p3(root, ["release-notes", "show", "v1", "--json"]).json();
    expect(d1.completion).toMatchObject({ ready: false, targets: [{ id: a }] });
    expect(p3(root, ["release-notes", "show", "v1"]).out).toContain("要望の一括完了: できません");
    expect(p3(root, ["release-notes", "complete-requests", "v1"]).err).toContain("--based-on");
    const blocked = p3(root, ["release-notes", "complete-requests", "v1", "--based-on", d1.completion.basedOn]);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("完了済にできません");
    // b を見送り: 判定が変わったので古い hash では 3（読み直してやり直す）
    expect(p3(root, ["request", "set", b, "status=rejected"]).code).toBe(0);
    expect(p3(root, ["release-notes", "complete-requests", "v1", "--based-on", d1.completion.basedOn]).code).toBe(3);
    const show = p3(root, ["release-notes", "show", "v1"]).out;
    expect(show).toContain("要望の一括完了: 対応済 1 件を完了済にできます");
    const d2 = p3(root, ["release-notes", "show", "v1", "--json"]).json();
    expect(show).toContain(`--based-on ${d2.completion.basedOn}`);
    const tasks = readFileSync(join(root, ".p3", "requests", a, "tasks", "T001.md"), "utf8");
    const ok = p3(root, ["release-notes", "complete-requests", "v1", "--based-on", d2.completion.basedOn, "--json"]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.json()).toMatchObject({ completed: [{ id: a }], notRun: [] });
    expect(p3(root, ["request", "show", a, "--json"]).json().item).toMatchObject({ status: "done", updatedBy: "human:tester" });
    expect(p3(root, ["request", "show", b, "--json"]).json().item.status).toBe("rejected");
    expect(readFileSync(join(root, ".p3", "requests", a, "tasks", "T001.md"), "utf8")).toBe(tasks);
    // 対象0件: 何も変えずに 0
    const d3 = p3(root, ["release-notes", "show", "v1", "--json"]).json();
    const none = p3(root, ["release-notes", "complete-requests", "v1", "--based-on", d3.completion.basedOn]);
    expect(none.code).toBe(0);
    expect(none.out).toContain("完了済にする要望はありません");
  });

  it("候補・材料が無いマイルストーンは生成を断り、手で書いて保存できる。未知の ID は 2、使えない ID は 1", () => {
    const { root } = setup();
    const gen = p3(root, ["release-notes", "generate", "v2", "--engine", "mock"]);
    expect(gen.code).toBe(1);
    expect(gen.err).toContain("要約の材料");
    // 始められないときは、手で書いて保存する道を添える
    expect(gen.err).toContain("生成せずに、本文を手で書いて保存できます");
    expect(gen.err).toContain("p3 release-notes save v2 --file <本文.md>");
    expect(gen.out).toBe("");
    expect(p3(root, ["release-notes", "show", "v2", "--json"]).json().material.warnings.map((w: any) => w.code)).toEqual(["no_candidates"]);
    expect(p3(root, ["release-notes", "save", "v2", "--body", "手で書いた"]).code).toBe(0);
    expect(p3(root, ["release-notes", "export", "v2"]).out).toBe("手で書いた\n");

    expect(p3(root, ["release-notes", "show", "nope"]).code).toBe(2);
    expect(p3(root, ["release-notes", "export", "v1"]).code).toBe(2); // まだ無い
    const bad = p3(root, ["release-notes", "show", ".."]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("使えません");
    expect(p3(root, ["release-notes", "save", "v1"]).err).toContain("--body");
    expect(p3(root, ["release-notes", "generate", "v1", "--engine", "x"]).code).toBe(1);
  });

  it("Codex が使えなければ失敗を明示し（Docker は起こさない）、Ctrl-C で取り消せる。どちらも保存したノートを変えない", async () => {
    const { root, file } = setup();
    expect(p3(root, ["release-notes", "save", "v1", "--body", "保存済み"]).code).toBe(0);
    const before = readFileSync(file, "utf8");

    // 個人設定が空なので Codex は未接続
    const fail = p3(root, ["release-notes", "generate", "v1"]);
    expect(fail.code).toBe(1);
    expect(fail.err).toContain("生成できませんでした（unavailable）");
    expect(fail.err).toContain("ChatGPT にサインインしてください");
    // 生成できなくても手で書いて保存できる（既にあるノートは show で読んだ版を付けて更新する）
    expect(fail.err).toContain("p3 release-notes save v1 --file <本文.md>");
    expect(fail.err).toContain("--version <版>");
    expect(fail.out).toBe("");
    const failJson = p3(root, ["release-notes", "generate", "v1", "--json"]);
    expect(failJson.code).toBe(1);
    expect(failJson.json()).toMatchObject({ status: "failed", failure: "unavailable" });
    expect(failJson.err).toContain("p3 release-notes save v1 --file <本文.md>");
    expect(readFileSync(file, "utf8")).toBe(before);
    // 案内どおりに、版を付けて手で書いた本文に更新できる
    const version = p3(root, ["release-notes", "show", "v1", "--json"]).json().note.version as string;
    const manual = join(root, "manual.md");
    writeFileSync(manual, "## 最初のリリース\n\n- 手で書いた\n");
    expect(p3(root, ["release-notes", "save", "v1", "--file", manual, "--version", version]).code).toBe(0);
    expect(p3(root, ["release-notes", "export", "v1"]).out).toBe("## 最初のリリース\n\n- 手で書いた\n");
    const saved = readFileSync(file, "utf8");

    // 取り消し（Mock は少し待つので、その間に SIGINT）
    const child = spawn(process.execPath, [BIN, "release-notes", "generate", "v1", "--engine", "mock"], { cwd: root, env: env() });
    let err = "";
    let out = "";
    let sent = false;
    child.stderr.on("data", (d) => {
      err += d;
      if (!sent && err.includes("Mock で要約します")) sent = child.kill("SIGINT");
    });
    child.stdout.on("data", (d) => (out += d));
    const code = await new Promise<number | null>((r) => child.on("close", r));
    expect(code).toBe(1);
    expect(err).toContain("取り消しました");
    // 取消は失敗と扱わない（手で書く道は出さない）
    expect(err).not.toContain("手で書いて保存できます");
    expect(out).toBe("");
    expect(readFileSync(file, "utf8")).toBe(saved);
  });
});
