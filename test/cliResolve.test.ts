// CLI を別のプロセスで動かして確かめる: プロジェクトの決まり方（登録が1つだけで決まったとき・データのフォルダが無いとき）。
// 共通の準備（CLI の呼び出し・テストごとの個人設定・初期化済みのプロジェクト）は cliHelpers.ts
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BIN, CONFIG_HOME, p3, repo, initialized, snapshot } from "./cliHelpers.ts";
import { git, tempDir } from "./helpers.ts";

describe("登録が1つだけで決まったとき（今いる場所では決まっていない）", () => {
  /** 登録が1つのプロジェクトに、要望・マイルストーン・添付を用意する（リポジトリの中で） */
  async function single() {
    const app = await repo();
    const data = join(tempDir("p3-assets-"), "app");
    expect(p3(app, ["init", "--yes", "--project", "app", "--dir", data]).code).toBe(0);
    const rid = p3(app, ["request", "new", "通知", "--json"]).json().id as string;
    expect(p3(app, ["new", "送信", "--req", rid]).code).toBe(0);
    expect(p3(app, ["milestone", "add", "v1"]).code).toBe(0);
    const { png } = await import("./imageFixture.ts");
    writeFileSync(join(app, "画面.png"), png(64, 48));
    const aid = p3(app, ["attach", "add", "画面.png", "--req", rid, "--json"]).json().id as string;
    return { app, data, rid, aid, nowhere: tempDir() };
  }

  it("変える操作は、何も読み書きせずに止まり、明示の方法と移る先を案内する", async () => {
    const { data, rid, aid, nowhere } = await single();
    writeFileSync(join(nowhere, "メモ.md"), "回答");
    const before = snapshot(data);
    const writes: string[][] = [
      ["request", "new", "関係ない作業"],
      ["req", "add", "関係ない作業"],
      ["new", "req", "関係ない作業"],
      ["add", "request", "関係ない作業"],
      ["new", "task", "x", "--req", rid],
      ["new", "x", "--req", rid],
      ["set", "T001", "title=x", "--req", rid],
      ["move", "T001", "doing", "--req", rid],
      ["check", "T001", "--req", rid],
      ["archive", "T001", "--req", rid],
      ["request", "set", rid, "status=active"],
      ["req", "archive", rid],
      ["request"],
      ["milestone", "add", "v2"],
      ["milestones", "set", "v1", "--title", "x"],
      ["milestone", "rm", "v1"],
      ["milestone", "remove", "v1"],
      ["config", "set", "name=x"],
      ["config", "x"],
      ["repo", "add", "infra"],
      ["repo", "set", "app", "role=x"],
      ["repo", "path", "app", nowhere],
      ["repo", "rm", "app"],
      ["preflight", rid],
      ["preflight", rid, "--note", "-", "--note-only"],
      ["accept", rid],
      ["attach", "add", "メモ.md", "--req", rid],
      ["attach", "get", aid, "--req", rid],
      ["attach", "get", aid, "--out", "out.png", "--req", rid],
      ["attach", "rm", aid, "--req", rid],
      ["release-notes", "generate", "v1"],
      ["release-note", "save", "v1"],
      ["answer", rid, "Q1", "--body", "回答"],
      ["metrics", "record", "post_release_defects", "0", "--from", "2026-11-01", "--to", "2026-11-30", "--source", "管理表"],
      ["metrics", "rm", "M1"],
      ["metrics", "知らない操作"],
      ["retro", rid, "confirm"],
      ["retrospective", "judge", "1", "--state", "occurred", "--req", rid],
      ["retro", rid, "知らない操作"],
      ["premise", "add", "--target", rid, "--reason", "x", "--req", rid],
      ["premises", rid, "ack", "P1", "--target", rid, "--condition", "x"],
      ["premise", rid, "知らない操作"],
      ["source", rid, "add", "--source", "x"],
      ["source", `${rid}/T001`, "A1", "rm", "S1"],
      ["source", rid, "知らない操作"],
      ["serve", "--port", "0"],
      ["知らないコマンド"],
    ];
    for (const args of writes) {
      const r = spawnSync(process.execPath, [BIN, ...args], {
        cwd: nowhere,
        encoding: "utf8",
        input: "回答",
        timeout: 10_000, // serve が待ち受けを始めたら止める（その場合は失敗になる）
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: CONFIG_HOME, P3_PREFLIGHT_ENGINE: "mock" },
      });
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain("今いる場所ではプロジェクトが決まりません（登録が1つだけなので「app」になりますが、変える操作はしません）");
      expect(r.stderr).toContain(data);
      expect(r.stderr).toContain("p3 --project app <コマンド>");
      expect(r.stderr).toContain("データのフォルダの中で実行する");
      expect(r.stdout).toBe("");
    }
    expect(snapshot(data)).toEqual(before);
    expect(readdirSync(nowhere)).toEqual(["メモ.md"]);
  });

  it("読むだけの操作は続け、標準エラーに警告する（--json の出力はそのまま読める）", async () => {
    const { rid, nowhere } = await single();
    const reads: string[][] = [
      ["whoami"],
      ["progress"],
      ["ls", "--req", rid],
      ["list", "--req", rid],
      ["show", `${rid}/T001`],
      ["find", rid],
      ["resolve", rid],
      ["request", "ls"],
      ["req", "list"],
      ["request", "show", rid],
      ["milestone"],
      ["milestones", "ls"],
      ["config"],
      ["repo"],
      ["repo", "ls"],
      ["notes", rid],
      ["attach", "--req", rid],
      ["attach", "ls", "--req", rid],
      ["release-notes"],
      ["release-note", "ls"],
      ["release-notes", "show", "v1"],
      ["revisit", rid],
      ["quality"],
      ["quality", "templates"],
      ["metrics"],
      ["metrics", "--milestone", "v1"],
      ["metrics", "records"],
      ["retro", rid],
      ["retrospective", "show", "--req", rid],
      ["premise", rid],
      ["premises", "ls", "--req", rid],
    ];
    for (const args of reads) {
      const r = p3(nowhere, [...args, "--json"]);
      expect(r.code, `${args.join(" ")}: ${r.err}`).toBe(0);
      expect(r.err).toContain("※ 今いる場所ではプロジェクトが決まらず、登録が1つだけなので「app」を表示しています。変える操作の前には対象を明示してください。");
      expect(r.err).toContain("p3 --project app <コマンド>");
      expect(() => r.json()).not.toThrow();
    }
    // まだ無いもの（Preflight のタスク案・リリースノート）を読むときも、止めずに「無い」と返す
    for (const args of [["drafts", rid], ["clarify", rid], ["release-notes", "export", "v1"]]) {
      const r = p3(nowhere, args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toContain("を表示しています");
      expect(r.err).not.toContain("変える操作はしません");
    }
    expect(p3(nowhere, ["whoami", "--json"]).json()).toMatchObject({ project: "app", via: "only", here: [] });
  });

  it("根拠の一括操作（--sources-json）は要望・タスク・案のどれでも、ファイル・標準入力を読む前に止まり、明示すれば保存できる。根拠の一覧は警告して読める", async () => {
    const { app, data, rid, nowhere } = await single();
    expect(p3(app, ["add", "書き出し", "--req", rid, "--criterion", "CSV で書き出せる"]).code).toBe(0);
    const pf = p3(app, ["preflight", rid, "--engine", "mock", "--json"]);
    expect(pf.code, pf.err).toBe(0);
    const run = pf.json().id as string;
    expect(p3(app, ["source", `${rid}/D1`, "--json"]).json().items.length).toBeGreaterThan(0);
    const file = join(nowhere, "ops.json");
    writeFileSync(file, JSON.stringify([{ op: "add", source: "経理規程" }]));
    const criterionFile = join(nowhere, "criterion-ops.json");
    writeFileSync(criterionFile, JSON.stringify([{ criterion: "A1", op: "add", source: "経理規程" }]));
    const before = snapshot(data);
    const bulk: { args: string[]; input?: string }[] = [
      { args: ["source", rid, "--sources-json", file] },
      { args: ["sources", rid, "--sources-json", "-"], input: JSON.stringify([{ op: "add", source: "標準入力" }]) },
      { args: ["source", "--sources-json", file, "--req", rid] },
      { args: ["source", `${rid}/T002`, "--sources-json", criterionFile] },
      { args: ["source", `${rid}/T002`, "A1", "--sources-json", file] },
      { args: ["source", `${rid}/T002`, "--sources-json", "-"], input: JSON.stringify([{ criterion: "A1", op: "add", source: "標準入力" }]) },
      { args: ["source", `${rid}/D1`, "--sources-json", criterionFile] },
      { args: ["source", `${rid}/D1`, "A1", "--sources-json", "-"], input: JSON.stringify([{ op: "add", source: "標準入力" }]) },
      // 読むより先に止まる（壊れた入力・無いファイルでも、入力の誤りではなくプロジェクトの案内）
      { args: ["source", rid, "--sources-json", join(nowhere, "無い.json")] },
      { args: ["source", rid, "--sources-json", "-"], input: "{ 壊れた" },
    ];
    for (const { args, input } of bulk) {
      const r = p3(nowhere, args, {}, CONFIG_HOME, input);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err, args.join(" ")).toContain("変える操作はしません");
      expect(r.err, args.join(" ")).not.toMatch(/--sources-json は|読めません|JSON/);
      expect(r.out).toBe("");
    }
    expect(snapshot(data)).toEqual(before);

    // 根拠の一覧は警告して読める（要望・タスク・案とその基準）
    for (const args of [["source", rid], ["sources", rid, "ls"], ["source", "show", "--req", rid], ["source", `${rid}/T002`], ["source", `${rid}/T002`, "A1", "show"], ["source", `${rid}/D1`, "A1"]]) {
      const r = p3(nowhere, [...args, "--json"]);
      expect(r.code, `${args.join(" ")}: ${r.err}`).toBe(0);
      expect(r.err).toContain("を表示しています");
      expect(() => r.json()).not.toThrow();
    }

    // 明示すれば同じ一括操作で保存できる
    const req = p3(nowhere, ["--project", "app", "source", rid, "--sources-json", file, "--json"]);
    expect(req.code, req.err).toBe(0);
    expect(req.json().sources).toEqual([expect.objectContaining({ id: "S1", source: "経理規程" })]);
    const task = p3(nowhere, ["--project", "app", "source", `${rid}/T002`, "--sources-json", "-", "--json"], {}, CONFIG_HOME, JSON.stringify([{ criterion: "A1", op: "add", source: "標準入力" }]));
    expect(task.code, task.err).toBe(0);
    expect(task.json().items[0].sources).toEqual([expect.objectContaining({ id: "S1", source: "標準入力" })]);
    const draft = p3(nowhere, ["--project", "app", "source", `${rid}/D1`, "--sources-json", criterionFile, "--run", run, "--json"]);
    expect(draft.code, draft.err).toBe(0);
    expect(draft.json().items[0].sources).toEqual([expect.objectContaining({ id: "S1", source: "経理規程" })]);
  });

  it("プロジェクトを明示するか、今いる場所で決まれば、変える操作もできる", async () => {
    const { app, data, nowhere } = await single();
    const made = (cwd: string, args: string[] = []) => {
      const r = p3(cwd, ["request", "new", "書ける", ...args, "--json"]);
      expect(r.code, r.err).toBe(0);
      expect(r.err).toBe("");
      expect(existsSync(join(data, "requests", r.json().id, "request.md"))).toBe(true);
    };
    made(nowhere, ["--project", "app"]);
    made(nowhere, ["--dir", data]);
    made(app);
    made(join(app, "docs"));
    made(data);
    git(app, "add", "-A");
    git(app, "commit", "-qm", "x");
    const wt = join(tempDir("p3-wt-"), "wt");
    git(app, "worktree", "add", "-q", wt, "-b", "topic");
    made(wt);
    // 登録していないリポジトリの中の .p3/ は、登録が無くても今いる場所で決まる
    const { root } = await initialized();
    const r = p3(root, ["request", "new", "書ける", "--json"], {}, tempDir("p3-config-"));
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe("");
  });

  it("登録が無い・複数あるときの案内は今までどおり", async () => {
    const nowhere = tempDir();
    expect(p3(nowhere, ["request", "new", "x"]).err).toContain("プロジェクトがまだありません");
    await single();
    const other = await repo();
    expect(p3(other, ["init", "--yes", "--project", "other", "--dir", join(tempDir("p3-assets-"), "other")]).code).toBe(0);
    const r = p3(nowhere, ["request", "new", "x"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("操作するプロジェクトが決まりません");
    expect(r.err).not.toContain("登録が1つだけ");
  });
});

describe("データのフォルダが無い・project.yaml が無い", () => {
  /** 登録したプロジェクト（データはリポジトリの外）と、関係ない場所 */
  async function registered() {
    const app = await repo();
    const data = join(tempDir("p3-assets-"), "app");
    expect(p3(app, ["init", "--yes", "--project", "app", "--dir", data]).code).toBe(0);
    return { app, data, nowhere: tempDir() };
  }
  const cfgOf = () => readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8");
  /** 止まったこと（終了コード 1・標準出力は空・案内は標準エラー） */
  const expectStopped = (r: ReturnType<typeof p3>, head: string, label: string) => {
    expect(r.code, `${label}: ${r.err}`).toBe(1);
    expect(r.out, label).toBe("");
    expect(r.err, label).toContain(head);
    expect(r.err).toContain("共有ドライブ");
    expect(r.err).toContain("p3 init --project");
  };
  const commands = (rid?: string): string[][] => [["whoami", "--json"], ["ls", "--json", ...(rid ? ["--req", rid] : [])], ["request", "new", "x", "--json"]];

  it("登録したフォルダが無くなったら、読む・書く・serve のどれも止まり、フォルダを作らない。登録を直せば戻る", async () => {
    const { app, data, nowhere } = await registered();
    const moved = `${data}-moved`;
    renameSync(data, moved);
    const cfg = cfgOf();
    for (const [cwd, extra] of [[app, []], [nowhere, ["--project", "app"]]] as const) {
      for (const args of commands()) {
        const r = p3(cwd, [...extra, ...args]);
        expectStopped(r, `データのフォルダがありません: ${data}`, args.join(" "));
        expect(r.err).toContain("p3 project ls");
        expect(r.err).toContain("p3 project rm app → p3 project add app <正しいフォルダ>（rm はデータを消さない）");
      }
    }
    // serve は自分で異常終了する（待ち受けを始めてタイムアウトで止められたのではない）
    const serve = spawnSync(process.execPath, [BIN, "serve", "--port", "39871"], {
      cwd: app,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: CONFIG_HOME },
    });
    expect(serve.signal).toBeNull();
    expect(serve.status).toBe(1);
    expect(serve.stderr).toContain("データのフォルダがありません");
    expect(existsSync(data)).toBe(false);
    expect(cfgOf()).toBe(cfg);

    // 案内どおりに登録を直す（rm はデータを消さない）
    expect(p3(nowhere, ["project", "ls"]).out).toContain(data);
    expect(p3(nowhere, ["project", "rm", "app"]).code).toBe(0);
    expect(existsSync(join(moved, "project.yaml"))).toBe(true);
    expect(p3(nowhere, ["project", "add", "app", moved]).code).toBe(0);
    expect(p3(nowhere, ["--project", "app", "repo", "path", app.split("/").at(-1)!.toLowerCase(), app]).code).toBe(0);
    const r = p3(app, ["request", "new", "戻った", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(moved, "requests", r.json().id, "request.md"))).toBe(true);
  });

  it("フォルダはあるが project.yaml が無いときも止まり、要望を書き足さない（--project・--dir のどちらでも）", async () => {
    const { app, data, nowhere } = await registered();
    const rid = p3(app, ["request", "new", "前からある", "--json"]).json().id as string;
    rmSync(join(data, "project.yaml"));
    const before = snapshot(data);
    const cfg = cfgOf();
    const yaml = join(data, "project.yaml");
    for (const [cwd, extra] of [[app, []], [nowhere, ["--project", "app"]], [nowhere, ["--dir", data]]] as const) {
      for (const args of commands(rid)) expectStopped(p3(cwd, [...extra, ...args]), `データのフォルダに project.yaml がありません: ${yaml}`, `${extra.join(" ")} ${args.join(" ")}`);
    }
    // 登録していないフォルダを --dir で指したときは、指し方を案内する
    const other = tempDir("p3-assets-");
    const r = p3(nowhere, ["--dir", other, "request", "new", "x"]);
    expectStopped(r, `データのフォルダに project.yaml がありません: ${join(other, "project.yaml")}`, "--dir 未登録");
    expect(r.err).toContain("--dir で指すときは、project.yaml のあるフォルダを指す");
    expect(readdirSync(other)).toEqual([]);
    expect(snapshot(data)).toEqual(before);
    expect(cfgOf()).toBe(cfg);
  });

  it("project.yaml があれば requests/ が無くても空のプロジェクトとして開ける", async () => {
    const { app, data } = await registered();
    rmSync(join(data, "requests"), { recursive: true });
    const ls = p3(app, ["request", "ls", "--json"]);
    expect(ls.code, ls.err).toBe(0);
    expect(ls.json()).toEqual([]);
    expect(p3(app, ["request", "new", "最初", "--json"]).code).toBe(0);
  });
});

describe("参照先として複数のプロジェクトに登録したリポジトリ", () => {
  it("本体にしているプロジェクトに決まり（via: cwd）、要望はそのデータだけに作る。whoami はほかの登録と --project を案内する", async () => {
    const a = await repo();
    const b = await repo();
    const aData = join(tempDir("p3-assets-"), "pa");
    const bData = join(tempDir("p3-assets-"), "pb");
    expect(p3(a, ["init", "--yes", "--project", "pa", "--dir", aData]).code).toBe(0);
    expect(p3(b, ["init", "--yes", "--project", "pb", "--dir", bData]).code).toBe(0);
    expect(p3(b, ["repo", "add", "a", a, "role=使う側"]).code).toBe(0);

    const who = p3(a, ["whoami", "--json"]);
    expect(who.code, who.err).toBe(0);
    expect(who.json()).toMatchObject({ project: "pa", via: "cwd", alsoReferencedBy: ["pb"] });
    expect(p3(a, ["whoami"]).out).toContain("ほかの登録    pb もここを参照先にしています（そちらを操作するなら p3 --project pb <コマンド>）");
    expect(p3(b, ["whoami", "--json"]).json()).toMatchObject({ project: "pb", via: "cwd", alsoReferencedBy: [] });

    const before = snapshot(bData);
    const rid = p3(a, ["request", "new", "通知", "--json"]).json().id as string;
    expect(existsSync(join(aData, "requests", rid))).toBe(true);
    expect(snapshot(bData)).toEqual(before);
  });
});
