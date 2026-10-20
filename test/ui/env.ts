// UI テストの使い捨ての環境: 一時のフォルダの中に HOME・個人設定・git リポジトリ・データを作り、本物の CLI（bin/p3.mjs）で
// 初期化して p3 serve（ビルドした画面）を 127.0.0.1 の空いたポートで起こす。手元の個人設定・プロジェクト・.p3-demo には触れない。
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gitInit, git, tempDir } from "../helpers.ts";

const P3_BIN = fileURLToPath(new URL("../../bin/p3.mjs", import.meta.url));
const run = promisify(execFile);

/** 親の環境から、子の p3 の対象の決まり方に効くものを外す（P3_*・INIT_CWD・git の場所の指定・XDG） */
export function childBaseEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const drop = (k: string) => k.startsWith("P3_") || k.startsWith("GIT_") || k.startsWith("XDG_") || k === "INIT_CWD" || k.startsWith("npm_");
  return Object.fromEntries(Object.entries(parent).filter((e): e is [string, string] => e[1] !== undefined && !drop(e[0])));
}

export interface UiEnv {
  root: string;
  home: string;
  repo: string;
  env: Record<string, string>;
  /** CLI を一時の環境で動かす（cwd はリポジトリ） */
  p3: (args: string[], input?: string) => Promise<string>;
  cleanup: () => Promise<void>;
}

/** 一時の環境を作り、p3 init でプロジェクトを作る */
export async function makeUiEnv(project = "uitest"): Promise<UiEnv> {
  const root = tempDir("p3-ui-");
  const home = join(root, "home");
  const repo = join(root, "repo");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  const env = {
    ...childBaseEnv(),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    GIT_CONFIG_NOSYSTEM: "1",
    P3_PREFLIGHT_ENGINE: "mock",
    P3_ACTOR: "human:tester",
  };
  gitInit(repo);
  await writeFile(join(repo, "README.md"), "# 経費精算アプリ\n\n社内の経費を申請・承認する。\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const p3 = async (args: string[], input?: string) => {
    const child = run("node", [P3_BIN, ...args], { cwd: repo, env, encoding: "utf8", timeout: 30_000 });
    if (input !== undefined) {
      child.child.stdin?.end(input);
    }
    return (await child).stdout;
  };
  await p3(["init", "--yes", "--project", project, "--description", "UI テスト用の経費精算アプリ"]);
  return { root, home, repo, env, p3, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** 空いているポート（実行ごと。CLI はポート 0 を受け付けないので、ここで選んで渡す） */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === "object" ? resolve(addr.port) : reject(new Error("ポートを選べません"))));
    });
  });
}

export interface Serve {
  url: string;
  /** これまでの出力（失敗の説明に出す） */
  log: () => string;
  stop: () => Promise<void>;
}

/** p3 serve を起こし、HTTP で画面が返るまで待つ。ポートが取られていたら（選んでから起こすまでの間に）別のポートで試し直す */
export async function startServe(e: UiEnv, opts: { attempts?: number; timeoutMs?: number; args?: string[] } = {}): Promise<Serve> {
  const attempts = opts.attempts ?? 3;
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const port = await freePort();
    const child = spawn("node", [P3_BIN, "serve", ...(opts.args ?? []), "--host", "127.0.0.1", "--port", String(port)], { cwd: e.repo, env: e.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const serve: Serve = { url: `http://127.0.0.1:${port}`, log: () => out, stop: () => stopChild(child) };
    const ready = await waitReady(serve.url, child, () => out, opts.timeoutMs ?? 20_000);
    if (ready.ok) return serve;
    await serve.stop();
    last = out;
    if (!ready.inUse) throw new Error(`p3 serve が起動しません（${ready.reason}）:\n${out}`);
  }
  throw new Error(`p3 serve を起こせません（${attempts} 回ともポートが使われていました）:\n${last}`);
}

type Ready = { ok: true } | { ok: false; inUse: boolean; reason: string };

async function waitReady(url: string, child: ChildProcess, log: () => string, timeoutMs: number): Promise<Ready> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once("exit", () => (exited = true));
  while (Date.now() < deadline) {
    if (exited) return { ok: false, inUse: /EADDRINUSE/.test(log()), reason: `途中で終わりました（終了コード ${child.exitCode ?? child.signalCode}）` };
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok && (await res.text()).includes('<div id="root"')) return { ok: true };
    } catch {
      // まだ待ち受けていない
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: false, inUse: false, reason: `${timeoutMs / 1000} 秒で画面が返りませんでした` };
}

/** 止めて、終わるまで待つ（応じなければ強制で） */
export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await done;
  clearTimeout(timer);
}
