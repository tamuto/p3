// CLI を別のプロセスで動かして確かめる: マシンごとの設定・p3 config・個人設定のプロジェクト・p3 repo。
// 共通の準備（CLI の呼び出し・テストごとの個人設定・初期化済みのプロジェクト）は cliHelpers.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_HOME, newConfigHome, p3, repo, initialized } from "./cliHelpers.ts";
import { git, gitInit, tempDir } from "./helpers.ts";

describe("マシンごとの設定（環境変数と個人設定。.env は読まない）", () => {
  const configFile = () => join(CONFIG_HOME, "infodb-p3", "config.yaml");
  const appendConfig = (text: string) => writeFileSync(configFile(), `${readFileSync(configFile(), "utf8")}${text}`);

  it("個人設定の preflight.engine: mock で Mock になり、無ければ Codex が使えない理由で失敗する（Mock にしない）", async () => {
    const { root, rid } = await initialized();
    const codex = p3(root, ["preflight", rid, "--json"], { DOCKER_HOST: "unix:///nonexistent.sock" });
    expect(codex.code).not.toBe(0);
    expect(codex.out + codex.err).not.toContain('"engine": "mock"');

    appendConfig("preflight:\n  engine: mock\n");
    const mock = p3(root, ["preflight", rid, "--json"]);
    expect(mock.code, mock.err).toBe(0);
    expect(mock.json()).toMatchObject({ status: "completed", engine: "mock" });
  });

  it("パッケージやプロジェクトに .env があっても読まない", async () => {
    const { root, rid } = await initialized();
    writeFileSync(join(root, ".env"), "P3_PREFLIGHT_ENGINE=mock\n");
    writeFileSync(join(root, ".p3", ".env"), "P3_PREFLIGHT_ENGINE=mock\n");
    const r = p3(root, ["preflight", rid, "--json"], { DOCKER_HOST: "unix:///nonexistent.sock" });
    expect(r.code).not.toBe(0);
    expect(readFileSync(new URL("../packages/tasks/src/core/context.ts", import.meta.url), "utf8")).not.toContain("loadEnvFile");
    expect(readFileSync(new URL("../packages/p3/src/cli/main.ts", import.meta.url), "utf8")).not.toContain("loadEnvFile");
  });

  it("読めない設定は、直す場所を示して終了コード 1", async () => {
    const { root } = await initialized();
    const env = p3(root, ["request", "ls"], { P3_CODEX_PATH_MAP: "/workspaces" });
    expect(env.code).toBe(1);
    expect(env.err).toMatch(/設定: 環境変数 P3_CODEX_PATH_MAP の「\/workspaces」が読めません/);
    appendConfig("serve:\n  port: web\n");
    const cfg = p3(root, ["whoami"]);
    expect(cfg.code).toBe(1);
    expect(cfg.err).toContain("個人設定 serve.port");
    // 個人設定のプロジェクトの一覧・登録は、マシンの設定が読めなくても使える
    expect(p3(root, ["project", "ls"]).code).toBe(0);
  });

  it("init・project add / rm で個人設定を書いても、マシンの設定は残る", async () => {
    const { root } = await initialized();
    appendConfig("codex:\n  pathMap:\n    /workspaces: /home/me/workspaces\n  ensureImage: false\n");
    const other = await repo();
    expect(p3(other, ["init", "--yes", "--project", "other", "--dir", join(other, ".p3")]).code).toBe(0);
    expect(p3(root, ["project", "rm", "other"]).code).toBe(0);
    expect(p3(other, ["project", "add", "other", join(other, ".p3")]).code).toBe(0);
    const text = readFileSync(configFile(), "utf8");
    expect(text).toContain("/workspaces: /home/me/workspaces");
    expect(text).toContain("ensureImage: false");
  });
});

describe("p3 config", () => {
  it("設定を変え、project.yaml に書く", async () => {
    const { root } = await initialized();
    expect(p3(root, ["config", "set", "description=経費精算", "instructions=個人情報に注意"]).code).toBe(0);
    expect(p3(root, ["config", "set", "branchPattern=feature"]).err).toContain("{id}");
    expect(p3(root, ["config", "set", "docs=docs"]).err).toContain("設定できるキー");
    expect(p3(root, ["config", "--json"]).json()).toMatchObject({
      description: "経費精算",
      preflight: { instructions: "個人情報に注意" },
    });
  });
});

describe("個人設定のプロジェクト（データはリポジトリの外）", () => {
  it("init で外のフォルダに作って登録し、以後はリポジトリの中・作業ツリー・プロジェクト名で決まる", async () => {
    const app = await repo();
    const p3Data = join(tempDir("p3-assets-"), "p3");
    const r = p3(join(app, "docs"), ["init", "--yes", "--project", "p3", "--dir", p3Data]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(p3Data, "project.yaml"))).toBe(true);
    expect(existsSync(join(app, ".p3"))).toBe(false);
    expect(readFileSync(join(p3Data, "project.yaml"), "utf8")).not.toContain("repo:"); // 手元の場所は共有するデータに書かない
    const cfg = readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8");
    expect(cfg).toContain(`dir: ${p3Data}`);
    expect(cfg).toContain(`${app.split("/").at(-1)!.toLowerCase()}: ${app}`);

    // 2つめのプロジェクト
    const other = await repo();
    const otherData = join(tempDir("p3-some-"), "other");
    expect(p3(other, ["init", "--yes", "--project", "other", "--dir", otherData]).code).toBe(0);

    // リポジトリの中なら、そのプロジェクト
    expect(p3(join(app, "docs"), ["whoami", "--json"]).json()).toMatchObject({ project: "p3", dataDir: p3Data, here: [app.split("/").at(-1)!.toLowerCase()] });
    expect(p3(other, ["whoami", "--json"]).json()).toMatchObject({ project: "other", dataDir: otherData });
    // データのフォルダの中でも
    expect(p3(p3Data, ["whoami", "--json"]).json().project).toBe("p3");
    // 関係ない場所では決まらず、選び方を案内する。--project で選べる
    const nowhere = tempDir();
    const ng = p3(nowhere, ["ls"]);
    expect(ng.code).toBe(1);
    expect(ng.err).toContain("p3 --project <名前>");
    expect(ng.err).toContain(p3Data);
    expect(p3(nowhere, ["whoami", "--json", "--project", "other"]).json().project).toBe("other");
    expect(p3(nowhere, ["whoami", "--project", "nope"]).err).toContain("登録されていません");

    // 要望を作り、要望の作業ツリーの中からでも決まる（作業ツリーはリポジトリの外に置いてもよい）
    const rid = p3(app, ["request", "new", "通知", "--json"]).json().id as string;
    expect(existsSync(join(p3Data, "requests", rid, "request.md"))).toBe(true);
    git(app, "add", "-A");
    git(app, "commit", "-qm", "x");
    const wt = join(tempDir("p3-wt-"), rid);
    git(app, "worktree", "add", "-q", wt, "-b", `req/${rid}`);
    expect(p3(wt, ["whoami", "--json"]).json()).toMatchObject({ project: "p3", request: rid });

    // 一覧（今いる場所のプロジェクトに *）・登録を外す
    expect(p3(app, ["project"]).out).toMatch(/^\* p3/m);
    expect(p3(nowhere, ["project", "rm", "other"]).code).toBe(0);
    // 登録が1つだけなら、どこからでもそれ
    expect(p3(nowhere, ["whoami", "--json"]).json().project).toBe("p3");
  });

  it("whoami はプロジェクトの決まり方（via）を出す。今いる場所で決まったのか、登録が1つだけで決まったのかを区別できる", async () => {
    const app = await repo();
    const data = join(tempDir("p3-assets-"), "app");
    expect(p3(app, ["init", "--yes", "--project", "app", "--dir", data]).code).toBe(0);
    const nowhere = tempDir();
    const via = (cwd: string, args: string[] = [], configHome = CONFIG_HOME) => p3(cwd, ["whoami", "--json", ...args], {}, configHome).json();

    expect(via(app)).toMatchObject({ project: "app", dataDir: data, via: "cwd" });
    expect(via(data).via).toBe("cwd");
    expect(via(nowhere)).toMatchObject({ project: "app", via: "only", here: [] });
    expect(via(nowhere, ["--project", "app"]).via).toBe("project");
    expect(via(nowhere, ["--dir", data]).via).toBe("dir");
    // 表でも分かる
    expect(p3(app, ["whoami"]).out).toContain("決まり方      cwd（今いる場所）");
    expect(p3(nowhere, ["whoami"]).out).toContain("決まり方      only（登録が1つだけ。今いる場所では決まっていない）");
    // 登録していないリポジトリの中の .p3/（via: legacy。initialized は自分の個人設定にも登録するので、空の個人設定で見る）
    const { root } = await initialized();
    expect(via(root, [], tempDir("p3-config-")).via).toBe("legacy");
  });

  it("既にあるデータのフォルダには join で参加する（別の人・別のマシンの想定）", async () => {
    const data = join(tempDir("p3-assets-"), "shared");
    const first = await repo();
    expect(p3(first, ["init", "--yes", "--project", "shared", "--dir", data, "--description", "共有"]).code).toBe(0);
    const before = readFileSync(join(data, "project.yaml"), "utf8");

    // 別の人: 個人設定は空、リポジトリは別の場所に clone した。init は断り、join で参加する
    newConfigHome();
    const clone = await repo();
    expect(p3(clone, ["init", "--yes", "--project", "shared", "--dir", data]).err).toContain(`参加するなら: p3 join --project shared --dir ${data}`);
    const r = p3(clone, ["join", "--yes", "--project", "shared", "--dir", data]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("参加しました");
    expect(readFileSync(join(data, "project.yaml"), "utf8")).toBe(before);
    // 共有の参照先が1つなので、このマシンのパスとして clone を登録する
    expect(p3(clone, ["whoami", "--json"]).json()).toMatchObject({ project: "shared", here: [expect.any(String)] });

    // init せずに登録だけ（リポジトリを指定）
    newConfigHome();
    expect(p3(tempDir(), ["project", "add", "shared", data, "--repo", clone]).err).toContain("--repo は使えなくなりました");
    expect(p3(tempDir(), ["project", "add", "shared", data]).code).toBe(0);
    const name = p3(tempDir(), ["--project", "shared", "repo", "ls", "--json"]).json()[0].name;
    expect(p3(tempDir(), ["--project", "shared", "repo", "path", name, clone]).code).toBe(0);
    expect(p3(clone, ["whoami", "--json"]).json().project).toBe("shared");
    expect(p3(tempDir(), ["project", "add", "x", tempDir()]).err).toContain("まだ p3 のプロジェクトではありません");
  });
});

describe("p3 repo（Preflight が読む参照先）", () => {
  it("3つ以上（git でないフォルダ・リポジトリの中のサブフォルダを含む）を足し・変え・消す。共有の定義とこのマシンのパスを分ける", async () => {
    const { root } = await initialized();
    // init がこのリポジトリを本体の参照先 app として登録している
    const before = p3(root, ["repo", "ls", "--json"]).json();
    expect(before.map((r: any) => [r.name, r.role, r.status, r.local])).toEqual([["app", "本体", "ok", root]]);

    const docsRepo = tempDir("docsrepo-");
    gitInit(docsRepo);
    await mkdir(join(docsRepo, "guide"));
    const infra = tempDir("infrarepo-"); // git でないフォルダ
    expect(p3(root, ["repo", "set", "app", "role=システム本体"]).code).toBe(0);
    expect(p3(root, ["repo", "add", "docs", join(docsRepo, "guide"), "role=ドキュメント"]).code).toBe(0);
    expect(p3(root, ["repo", "set", "docs", "mapFile=MAP.md"]).err).toContain("変えられるキー: role readFirst writable");
    const added = p3(root, ["repo", "add", "infra", infra, "role=基盤"]);
    expect(added.code, added.err).toBe(0);
    const ls = p3(root, ["repo", "ls", "--json"]).json();
    expect(ls.map((r: any) => [r.name, r.role, r.readFirst, r.writable, r.status, r.mount])).toEqual([
      ["app", "システム本体", true, true, "ok", "app"],
      ["docs", "ドキュメント", false, false, "ok", "docs"],
      ["infra", "基盤", false, false, "ok", "infra"],
    ]);
    // 共有の定義は project.yaml、このマシンのパスは個人設定（パスを共有のファイルに書かない）
    const yaml = readFileSync(join(root, ".p3", "project.yaml"), "utf8");
    expect(yaml).toContain("app:");
    expect(yaml).not.toContain(infra);
    const config = readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8");
    expect(config).toContain(infra);

    // 変える・同じ名前を足せない・使えない名前・フォルダでないもの
    expect(p3(root, ["repo", "set", "infra", "role=基盤（Terraform）", "readFirst=true"]).code).toBe(0);
    expect(p3(root, ["repo", "ls", "--json"]).json().find((r: any) => r.name === "infra")).toMatchObject({ role: "基盤（Terraform）", readFirst: true });
    expect(p3(root, ["repo", "add", "infra", infra]).err).toContain("既にあります");
    expect(p3(root, ["repo", "add", "a:b", infra]).err).toContain("使えません");
    expect(p3(root, ["repo", "add", "x", join(root, "README.md")]).err).toContain("フォルダではありません");
    expect(p3(root, ["repo", "set", "infra", "readFirst=maybe"]).err).toContain("true か false");

    // ほかの人: 共有の定義はあるが、このマシンのパスが無い → 未登録として案内
    const otherHome = tempDir("p3-config-other-");
    expect(p3(root, ["project", "add", "other", join(root, ".p3")], {}, otherHome).code).toBe(0);
    expect(p3(root, ["--project", "other", "repo", "path", "app", root], {}, otherHome).code).toBe(0);
    const theirs = p3(root, ["--project", "other", "repo", "ls"], {}, otherHome);
    expect(theirs.out).toContain("未登録 → p3 repo path docs <このマシンのパス>");
    expect(p3(root, ["--project", "other", "repo", "path", "docs", join(docsRepo, "guide")], {}, otherHome).code).toBe(0);
    expect(p3(root, ["--project", "other", "repo", "ls", "--json"], {}, otherHome).json().find((r: any) => r.name === "docs").status).toBe("ok");

    // このマシンのパスだけ外す（共有は残る）・共有ごと消す
    p3(root, ["user-config", "set", "ui.theme=dark"]);
    expect(p3(root, ["repo", "rm", "infra", "--local"]).code).toBe(0);
    expect(p3(root, ["repo", "ls", "--json"]).json().find((r: any) => r.name === "infra").status).toBe("unregistered");
    expect(p3(root, ["repo", "rm", "docs"]).code).toBe(0);
    expect(p3(root, ["repo", "ls", "--json"]).json().map((r: any) => r.name)).toEqual(["app", "infra"]);
    expect(readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8")).toContain("theme: dark"); // ほかの個人設定は残る
    // --dir で指しても読める（登録していないフォルダではパスの登録は案内）
    expect(p3(root, ["--dir", join(root, ".p3"), "repo", "ls", "--json"]).json().map((r: any) => r.name)).toEqual(["app", "infra"]);
  });
});
