// CLI を別のプロセスで動かして確かめる: 要望とタスクの基本の操作（作成・移動・終了コード・要望の作業ツリー・タグ・成果物）。
// 共通の準備（CLI の呼び出し・テストごとの個人設定・初期化済みのプロジェクト）は cliHelpers.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_HOME, p3, repo, initialized, relate } from "./cliHelpers.ts";
import { git, tempDir } from "./helpers.ts";

describe("p3 request", () => {
  it("要望は日付-乱数のフォルダになり、一部の ID でも指せる", async () => {
    const { root, rid } = await initialized();
    expect(rid).toMatch(/^\d{6}-[0-9a-z]{5}$/);
    expect(existsSync(join(root, ".p3", "requests", rid, "request.md"))).toBe(true);
    expect(p3(root, ["request", "ls", "--json"]).json().map((r: any) => r.id)).toEqual([rid]);
    expect(p3(root, ["request", "set", rid.slice(-5), "status=active"]).code).toBe(0);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");
    expect(p3(root, ["request", "set", rid, "status=accepted"]).err).toContain("要望のステータス");
  });
});

describe("p3 のタスク操作（--req で要望を指定）", () => {
  it("作成・一覧・更新・移動・関係・アーカイブ", async () => {
    const { root, rid } = await initialized();
    const r = ["--req", rid];
    expect(p3(root, ["new", "API の認証", "--area", "src/api", ...r]).out).toContain(`${rid}/T001`);
    // 本文が - で始まっても受け取れる
    expect(p3(root, ["new", "通知", "--body", "- 箇条書き", ...r]).code).toBe(0);
    expect(readFileSync(join(root, ".p3", "requests", rid, "tasks", "T002.md"), "utf8")).toContain("- 箇条書き");

    relate(root, rid, "T002", [{ type: "depends_on", target: "T001" }]);
    // 関係を手で張る・影響範囲のコマンドは無い
    for (const cmd of ["link", "unlink", "impact"]) expect(p3(root, [cmd, "T2", "depends_on", "T1", ...r]).err).toContain("不明なコマンド");

    expect(p3(root, ["move", "T2", "doing", ...r]).code).toBe(0);
    expect(p3(root, ["move", "2", "in_progress", ...r]).err).toContain("ステータスは");
    expect(p3(root, ["set", "1", "labels=a,b", "outputs=docs/a.md", ...r]).code).toBe(0);
    expect(p3(root, ["set", "1", "outputs=", ...r]).code).toBe(0);
    expect(p3(root, ["set", "1", "due=2026-10-20", ...r]).err).toContain("変更できるキー"); // 予定の日付は持たない

    const ls = p3(root, ["ls", "--status", "todo", "--json", ...r]).json();
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ id: "T001", labels: ["a", "b"], outputs: [] });
    // 作業中にした日時は記録される
    expect(p3(root, ["show", "T2", "--json", ...r]).json().item.startedAt).toBeTruthy();

    const show = p3(root, ["show", "T1", "--json", ...r]).json();
    expect(show.dependents).toEqual([{ ref: `${rid}/T002`, title: "通知", status: "doing" }]);
    expect(show).not.toHaveProperty("graph");
    // 「相手の役割 + 相手」で見せる: T002 → depends_on → T001 なら、T001 には「依存元 T002」、T002 には「依存先 T001」
    expect(p3(root, ["show", "T1", ...r]).out).toMatch(/← 依存元 +T002/);
    expect(p3(root, ["show", "T2", ...r]).out).toMatch(/→ 依存先 +T001/);
    expect(p3(root, ["help"]).out).toContain("depends_on    依存する（相手が先に終わっている必要がある）  →「依存先」/ 逆「依存元」");
    expect(p3(root, ["find", "通知", "--json", ...r]).json().candidates.map((c: any) => c.ref)).toContain(`${rid}/T002`);

    expect(p3(root, ["archive", "2", ...r]).code).toBe(0);
    expect(p3(root, ["show", "T2", ...r]).code).toBe(2); // アーカイブしたら見つからない
  });

  it("move --output で成果物（PR の URL など）を足す。全要望の一覧と進捗", async () => {
    const { root, rid } = await initialized();
    p3(root, ["new", "A", "--req", rid]);
    p3(root, ["new", "B", "--req", rid]);
    // AI が完了にするときは変更の記録が要る（無ければ何も変えずに断る）
    const ng = p3(root, ["move", "T1", "done", "--output", "https://example.com/pull/7", "--req", rid], { P3_ACTOR: "ai:claude" });
    expect(ng.code).toBe(1);
    expect(ng.err).toContain("--record で変更の記録");
    expect(p3(root, ["show", `${rid}/T1`, "--json"]).json().item.status).toBe("todo");
    const record = "- 認証の失敗を 401 で返すようにした\n- 理由: 画面が再ログインに誘導できないため\n- 決まり: 期限切れは 401、権限なしは 403";
    const done = p3(root, ["move", "T1", "done", "--output", "https://example.com/pull/7", "--record", "-", "--req", rid], { P3_ACTOR: "ai:claude" }, CONFIG_HOME, record);
    expect(done.code, done.err).toBe(0);
    const t = p3(root, ["show", `${rid}/T1`, "--json"]).json().item;
    expect(t).toMatchObject({ status: "done", outputs: ["https://example.com/pull/7"], updatedBy: "ai:claude", record });
    expect(readFileSync(join(root, ".p3", "requests", rid, "tasks", "T001.md"), "utf8")).toContain("期限切れは 401");
    // 作業に読む短い出力にも出る。人は記録なしでも完了にできる
    expect(p3(root, ["show", `${rid}/T1`, "--brief", "--json"]).json().item.record).toBe(record);
    expect(p3(root, ["show", `${rid}/T1`, "--brief"]).out).toContain("## 変更の記録\n- 認証の失敗");
    expect(p3(root, ["show", `${rid}/T1`]).out).toContain("変更の記録:\n  - 認証の失敗");
    expect(p3(root, ["move", "T2", "done", "--req", rid]).code).toBe(0);
    expect(p3(root, ["move", "T2", "todo", "--req", rid]).code).toBe(0);
    // タスク単位の「済み」は無い（人の最終確認は要望を完了済にする）
    expect(p3(root, ["check", "T1", "--req", rid]).code).toBe(1);
    expect(p3(root, ["ls", "--all", "--json"]).json()).toHaveLength(2);
    const progress = p3(root, ["progress", "--json"]).json();
    expect(progress[0]).toMatchObject({ total: 2, done: 1, counts: { todo: 1, doing: 0, done: 1 } });
    expect(p3(root, ["progress"]).out).toContain("1/2");
  });

  it("終了コード: 競合は 3、見つからないは 2、使い方の誤りは 1。要望が決まらなければ案内する", async () => {
    const { root, rid } = await initialized();
    const r = ["--req", rid];
    p3(root, ["new", "A", ...r]);
    p3(root, ["set", "1", "labels=x", ...r]);
    const conflict = p3(root, ["move", "1", "done", "--rev", "1", ...r]);
    expect(conflict.code).toBe(3);
    expect(conflict.err).toContain("競合");
    expect(p3(root, ["move", "1", "done", "--rev", "2", ...r]).code).toBe(0);
    expect(p3(root, ["move", "99", "done", ...r]).code).toBe(2);
    expect(p3(root, ["show", "T099", ...r]).code).toBe(2); // show は語句でも探す。何も当たらなければ 2
    expect(p3(root, ["nope"]).code).toBe(1);
    expect(p3(root, ["set", "1", "color=red", ...r]).err).toContain("変更できるキー");
    const noReq = p3(root, ["new", "どこに？"]);
    expect(noReq.code).toBe(1);
    expect(noReq.err).toContain("要望を指定");
  });

  it("プロジェクトが無ければ init を案内する", async () => {
    const root = await repo();
    const r = p3(root, ["ls"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("p3 init --project");
  });
});

describe("要望の作業ツリー", () => {
  it("要望のブランチ・作業ツリーの中では要望の指定を省け、書き込みはメインの .p3/ に行く", async () => {
    const { root, rid } = await initialized();
    const run = p3(root, ["preflight", rid, "--engine", "mock", "--json"]);
    expect(run.code, run.err).toBe(0);
    p3(root, ["accept", rid]);
    const branch = p3(root, ["request", "show", rid, "--json"]).json().item.workstreams.app.branch;
    expect(branch).toBe(`req/${rid}`);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "p3");
    const wt = join(root, ".worktrees", rid);
    git(root, "worktree", "add", "-q", wt, "-b", branch);

    // AI が作業ツリーで作業している想定
    const ai = { P3_ACTOR: "ai:claude" };
    expect(p3(wt, ["whoami", "--json"], ai).json()).toMatchObject({ actor: "ai:claude", request: rid });
    expect(p3(wt, ["move", "T1", "doing"], ai).code).toBe(0);
    const added = p3(wt, ["new", "作業中に見つかった追加の作業", "--json"], ai).json();
    expect(added.ref).toBe(`${rid}/T004`);
    expect(readFileSync(join(root, ".p3", "requests", rid, "tasks", "T001.md"), "utf8")).toContain("status: doing");
    expect(existsSync(join(root, ".p3", "requests", rid, "tasks", "T004.md"))).toBe(true);
    // 作業ツリーの .p3/ はブランチ時点の写しのまま
    expect(readFileSync(join(wt, ".p3", "requests", rid, "tasks", "T001.md"), "utf8")).toContain("status: todo");
    expect(existsSync(join(wt, ".p3", "requests", rid, "tasks", "T004.md"))).toBe(false);

    // `pnpm --dir <p3 の場所> p3 ...` で呼ばれたとき（pnpm がカレントを p3 の場所に移し、元の場所は INIT_CWD）
    const viaPnpm = { ...ai, npm_lifecycle_event: "p3", npm_package_name: "@infodb/p3", INIT_CWD: wt };
    expect(p3(fileURLToPath(new URL("..", import.meta.url)), ["whoami", "--json"], viaPnpm).json()).toMatchObject({ actor: "ai:claude", request: rid });
    // 開発のリポジトリのルート（pnpm workspace の p3-workspace）の "p3" スクリプトから呼ばれたときも、呼び出し元に戻る
    const viaWorkspace = { ...viaPnpm, npm_package_name: "p3-workspace" };
    expect(p3(fileURLToPath(new URL("..", import.meta.url)), ["whoami", "--json"], viaWorkspace).json()).toMatchObject({ actor: "ai:claude", request: rid });
    // 利用者のパッケージの "p3" スクリプトから呼ばれたとき（pnpx・npm exec も）は、今の場所のまま
    const viaUserScript = { ...ai, npm_lifecycle_event: "p3", npm_package_name: "myapp", INIT_CWD: tempDir() };
    expect(p3(wt, ["whoami", "--json"], viaUserScript).json()).toMatchObject({ request: rid });
  });
});

describe("タグ（外部 ID・分類）", () => {
  it("--tag は値ごと（カンマで分けない）。request set --tag で置き換え、tags= はカンマで分ける。両方は使えない", async () => {
    const { root, rid } = await initialized();
    const made = p3(root, ["request", "new", "外部 ID つき", "--tag", "jira:PROJ-123", "--tag", " group:顧客A ", "--tag", "a,b", "--tag", "jira:PROJ-123", "--tag", " ", "--json"]).json();
    expect(made.tags).toEqual(["jira:PROJ-123", "group:顧客A", "a,b"]);
    const set = p3(root, ["request", "set", rid, "--tag", "release/2026Q4", "--tag", "顧客 A, 東京", "--json"]);
    expect(set.code, set.err).toBe(0);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.tags).toEqual(["release/2026Q4", "顧客 A, 東京"]);
    expect(p3(root, ["request", "set", rid, "tags=x, y"]).code).toBe(0);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.tags).toEqual(["x", "y"]);
    const both = p3(root, ["request", "set", rid, "tags=x", "--tag", "y"]);
    expect(both.code).not.toBe(0);
    expect(both.err).toContain("一緒に使えません");
    expect(p3(root, ["request", "set", rid, "tags="]).code).toBe(0);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.tags).toEqual([]);
    // 繰り返した --tag はどれか（完全一致）
    expect(p3(root, ["request", "ls", "--tag", "a,b", "--tag", "nothing", "--json"]).json().map((r: any) => r.id)).toEqual([made.id]);
    expect(p3(root, ["request", "ls", "--tag", "JIRA:PROJ-123", "--json"]).json()).toEqual([]);
  });
});

describe("成果物（URL・文章・パス）", () => {
  it("--output は繰り返して足せ、カンマで分けない。outputs= はカンマで分けて置き換える", async () => {
    const { root, rid } = await initialized();
    const made = p3(root, ["new", "成果物つき", "--req", rid, "--output", "https://example.com/pull/1", "--output", "設計の要点, 判断の理由は docs/x.md に", "--json"]).json();
    expect(made.outputs).toEqual(["https://example.com/pull/1", "設計の要点, 判断の理由は docs/x.md に"]);
    expect(p3(root, ["move", made.id, "done", "--req", rid, "--output", "docs/x.md", "--output", "https://example.com/pull/1"]).code).toBe(0);
    const shown = p3(root, ["show", made.id, "--req", rid, "--json"]).json();
    expect(shown.item.outputs).toEqual(["https://example.com/pull/1", "設計の要点, 判断の理由は docs/x.md に", "docs/x.md"]);
    expect(p3(root, ["show", made.id, "--req", rid, "--brief", "--json"]).json().item.outputs).toEqual(shown.item.outputs);
    expect(p3(root, ["set", made.id, "--req", rid, "outputs=a, b"]).code).toBe(0);
    expect(p3(root, ["show", made.id, "--req", rid, "--json"]).json().item.outputs).toEqual(["a", "b"]);
  });
});
