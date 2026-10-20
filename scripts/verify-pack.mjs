#!/usr/bin/env node
// 配布物（npm pack の tarball）を、このチェックアウト・隣の llmcs・今の個人設定に頼らずに確かめる。
//
//   node scripts/verify-pack.mjs [--tgz <tarball>] [--docker [--render-dir <フォルダ>]] [--keep]
//
//   1. npm pack（prepack で画面をビルドする）。--tgz を渡せばそれを使う
//   2. 一時フォルダに、tarball を実行時の依存だけで入れる（npm install。レジストリから取る）
//   3. 別に作った git リポジトリを今の場所にし、個人設定・HOME も一時フォルダにして、入れた p3 を動かす:
//      init --agents / init --agents codex と p3 agents / whoami / request new / Mock の Preflight / メモを足した再評価 / drafts / serve（HTML・資産・API）
//   4. --docker を付けると、本物の Docker で codex update（未登録・未認証のまま、イメージを作り直して版を読む）と
//      p3 render（配布物の描画の資材でイメージを作り、日本語の HTML を PNG にする）。DevContainer の中では
//      --render-dir <Docker のホストから見えるフォルダ> と環境変数 P3_CODEX_PATH_MAP を渡す
//
// 依存を使わない（Node だけで動く）。CI には入れない。公開の前に人が実行する（docs/publishing.md）。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const work = mkdtempSync(join(tmpdir(), "p3-verify-"));
/** 終わったら消すもの（work の外に作ったもの） */
const cleanup = [];
const results = [];
const step = async (name, f) => {
  process.stderr.write(`… ${name}\n`);
  try {
    const detail = await f();
    results.push({ name, ok: true, detail });
    process.stderr.write(`✓ ${name}${detail ? `  ${detail}` : ""}\n`);
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
    process.stderr.write(`✗ ${name}\n  ${e.message.split("\n").join("\n  ")}\n`);
    throw e;
  }
};
const check = (cond, message) => {
  if (!cond) throw new Error(message);
};

// 入れた p3 を動かす環境: このマシンの P3_* と個人設定は使わない。HOME も分ける（npm のキャッシュ・~/.config）
const home = join(work, "home");
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_") && !k.startsWith("npm_"))),
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  npm_config_cache: join(work, "npm-cache"),
  // docker の接続先（コンテキスト）はこのマシンのものを使う
  DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(process.env.HOME ?? "", ".docker"),
};
const sh = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], ...opts });

let tgz = option("tgz") && resolve(option("tgz"));
const prefix = join(work, "install");
const repo = join(work, "repo");
const p3 = (argv, opts) => sh(join(prefix, "node_modules", ".bin", "p3"), argv, { cwd: repo, ...opts });
const p3json = (argv) => JSON.parse(p3([...argv, "--json"]));

try {
  await step("Node の版", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const major = Number(process.versions.node.split(".")[0]);
    const min = Number(/>=\s*(\d+)/.exec(pkg.engines.node)?.[1]);
    check(major >= min, `Node ${process.version} は engines（${pkg.engines.node}）を満たしません`);
    return `${process.version}（engines ${pkg.engines.node}）`;
  });

  if (!tgz) {
    await step("npm pack（prepack で画面をビルド）", () => {
      const out = execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
      const info = JSON.parse(out.slice(out.indexOf("[")))[0];
      tgz = join(work, info.filename);
      return `${info.filename}  ${info.entryCount} ファイル`;
    });
  }

  await step("tarball の中身", () => {
    const files = sh("tar", ["tzf", tgz]).trim().split("\n").map((f) => f.replace(/^package\//, ""));
    for (const f of ["bin/p3.mjs", "src/cli/main.ts", "dist/web/index.html", "skills/p3/SKILL.md", "LICENSE", "README.md", "src/core/preflight/render-image/Dockerfile", "src/core/preflight/render-image/render.mjs"]) {
      check(files.includes(f), `${f} が入っていません`);
    }
    const unwanted = files.filter((f) => /^(\.env|\.p3|\.claude\/|test\/|scripts\/|src\/web\/|node_modules\/)/.test(f));
    check(unwanted.length === 0, `入れてはいけないもの: ${unwanted.join(", ")}`);
    return `${files.length} ファイル`;
  });

  await step("実行時の依存だけで入れる（npm install）", () => {
    mkdirSync(prefix, { recursive: true });
    writeFileSync(join(prefix, "package.json"), '{ "name": "p3-verify", "private": true }\n');
    sh("npm", ["install", "--no-audit", "--no-fund", "--omit=dev", tgz], { cwd: prefix });
    const installed = JSON.parse(readFileSync(join(prefix, "node_modules", "@infodb", "p3", "package.json"), "utf8"));
    check(!existsSync(join(prefix, "node_modules", "vite")), "開発用の依存（vite）まで入っています");
    check(!existsSync(join(prefix, "node_modules", "react")), "画面の部品（react）まで入っています");
    const cw = JSON.parse(readFileSync(join(prefix, "node_modules", "@infodb", "codex-workspace", "package.json"), "utf8"));
    return `@infodb/p3 ${installed.version}・@infodb/codex-workspace ${cw.version}`;
  });

  await step("対象のリポジトリを作る（P3 のチェックアウトの外）", () => {
    mkdirSync(repo, { recursive: true });
    sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# sample\n");
    sh("git", ["-c", "user.name=verify", "-c", "user.email=verify@example.com", "add", "."], { cwd: repo });
    sh("git", ["-c", "user.name=verify", "-c", "user.email=verify@example.com", "commit", "-q", "-m", "init"], { cwd: repo });
    return repo;
  });

  await step("p3 init --agents", () => {
    p3(["init", "--yes", "--agents", "--project", "sample", "--dir", join(work, "data"), "--description", "検証用"]);
    check(existsSync(join(work, "data", "project.yaml")), "データのフォルダができていません");
    check(readFileSync(join(repo, "AGENTS.md"), "utf8").includes("タスク管理（infodb p3）"), "AGENTS.md に追記されていません");
    // スキルは Claude Code と Codex の2か所に、配布物の原本と同じものを置く
    const original = readFileSync(join(prefix, "node_modules", "@infodb", "p3", "skills", "p3", "SKILL.md"), "utf8");
    for (const dir of [".claude", ".agents"]) {
      const placed = join(repo, dir, "skills", "p3", "SKILL.md");
      check(existsSync(placed) && readFileSync(placed, "utf8") === original, `スキルが ${dir}/skills/p3/SKILL.md に置かれていません（配布物の原本と違います）`);
    }
  });

  await step("p3 init --agents codex（選んだ先だけ）と p3 agents（後から足す・最新にする）", () => {
    const original = readFileSync(join(prefix, "node_modules", "@infodb", "p3", "skills", "p3", "SKILL.md"), "utf8");
    const other = join(work, "repo-codex");
    mkdirSync(other, { recursive: true });
    sh("git", ["init", "-q", "-b", "main"], { cwd: other });
    p3(["init", "--yes", "--agents", "codex", "--project", "codex-only", "--dir", join(work, "data-codex")], { cwd: other });
    check(existsSync(join(other, ".agents", "skills", "p3", "SKILL.md")), "--agents codex で .agents/skills/p3/SKILL.md が置かれていません");
    check(!existsSync(join(other, ".claude")), "--agents codex なのに .claude まで置かれています");
    p3(["agents", "claude"], { cwd: other });
    const claude = join(other, ".claude", "skills", "p3", "SKILL.md");
    check(existsSync(claude) && readFileSync(claude, "utf8") === original, "p3 agents claude で .claude/skills/p3/SKILL.md が置かれていません");
    writeFileSync(claude, "# 古い版\n");
    p3(["agents", "claude", "--force"], { cwd: other });
    check(readFileSync(claude, "utf8") === original, "p3 agents claude --force で最新になっていません");
  });

  await step("p3 whoami", () => {
    const w = p3json(["whoami"]);
    check(w.project === "sample", `プロジェクトが違います: ${JSON.stringify(w)}`);
    return `${w.project} → ${w.dataDir ?? ""}`;
  });

  let rid = "";
  await step("要望を作り、Mock で Preflight", () => {
    rid = p3json(["request", "new", "通知機能", "--body", "- 送信基盤\n- 設定画面"]).id;
    const run = p3json(["preflight", rid, "--engine", "mock"]);
    check(run.status === "completed", `Preflight が完了しません: ${run.status}`);
    return `${rid} ${run.id}`;
  });

  await step("メモを足して再評価", () => {
    const run = p3json(["preflight", rid, "--engine", "mock", "--note", "- 再送も入れる"]);
    check(run.status === "completed" && run.previous && run.notes?.length === 1, `前回とメモが引き継がれていません: ${JSON.stringify({ previous: run.previous, notes: run.notes })}`);
    const drafts = p3(["drafts", rid]);
    check(drafts.includes("再送"), "メモの案がタスク案にありません");
    return run.id;
  });

  await step("p3 serve（画面・資産・API）", async () => {
    const port = await freePort();
    const child = spawn(join(prefix, "node_modules", ".bin", "p3"), ["serve", "--port", String(port), "--host", "127.0.0.1"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    try {
      const base = `http://127.0.0.1:${port}`;
      const html = await retry(() => fetchText(`${base}/`));
      check(/<div id="root">/.test(html), "画面の HTML ではありません");
      const asset = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      check(asset, "HTML から資産（/assets/*.js）が見つかりません");
      check((await fetchText(`${base}${asset}`)).length > 1000, `${asset} が読めません`);
      const requests = JSON.parse(await fetchText(`${base}/api/requests`));
      check(JSON.stringify(requests).includes(rid), "API に要望がありません");
      return `${base}  ${asset}`;
    } catch (e) {
      throw new Error(`${e.message}\n--- serve の出力 ---\n${log}`);
    } finally {
      child.kill();
    }
  });

  if (flag("docker")) {
    await step("p3 codex update（本物の Docker。未登録・未認証のまま）", () => {
      const nowhere = join(work, "nowhere");
      mkdirSync(nowhere, { recursive: true });
      const r = JSON.parse(p3(["codex", "update", "--json"], { cwd: nowhere, stdio: ["ignore", "pipe", "inherit"] }));
      check(r.ok && /\d+\.\d+/.test(r.version), `版を読めません: ${JSON.stringify(r)}`);
      return `${r.version}（前 ${r.previous ?? "なし"}）`;
    });
    await step("p3 render（本物の Docker。配布物の資材だけでイメージを作り、日本語の HTML を PNG にする）", () => {
      // DevContainer の中では、一時フォルダは Docker のホストから見えない。--render-dir と P3_CODEX_PATH_MAP で渡す
      const dir = option("render-dir") ? resolve(option("render-dir"), `p3-verify-render-${process.pid}`) : join(work, "render");
      mkdirSync(dir, { recursive: true });
      cleanup.push(dir);
      writeFileSync(join(dir, "page.html"), '<!doctype html><html lang="ja"><meta charset="utf-8"><body style="font-family:sans-serif"><h1>要望一覧</h1><p>絞り込み</p></body></html>');
      const renderEnv = { ...env, ...(process.env.P3_CODEX_PATH_MAP ? { P3_CODEX_PATH_MAP: process.env.P3_CODEX_PATH_MAP } : {}) };
      const r = JSON.parse(p3(["render", join(dir, "page.html"), "--width", "800", "--json"], { cwd: dir, env: renderEnv, stdio: ["ignore", "pipe", "inherit"] }));
      check(r.ok && readFileSync(r.file).subarray(1, 4).toString() === "PNG", `描画できません: ${JSON.stringify(r)}`);
      return r.file;
    });
  } else {
    results.push({ name: "p3 codex update / p3 render（本物の Docker）", ok: null, detail: "--docker を付けていないので実行していない" });
  }
} catch {
  // 結果は下でまとめて出す
} finally {
  const failed = results.some((r) => r.ok === false);
  process.stdout.write(`${JSON.stringify({ ok: !failed, node: process.version, work, results }, null, 2)}\n`);
  if (!flag("keep") && !failed) for (const d of [work, ...cleanup]) rmSync(d, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}

async function retry(f, times = 50) {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= times) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

