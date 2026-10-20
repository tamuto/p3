#!/usr/bin/env node
// Docker のイメージ（Dockerfile）を、使い捨ての2つのプロジェクトで確かめる（スモーク）。
//
//   node scripts/verify-docker.mjs [--image <名前>] [--no-build] [--work <フォルダ>] [--network-of <コンテナ>|auto] [--keep]
//
//   1. docker build（--no-build なら --image のイメージをそのまま使う。既定の名前は infodb-p3:verify）
//   2. --work の下に個人設定と2つのプロジェクト（alpha・beta。beta は alpha のデータを写して同じ ID にする）を作る
//   3. 既定のコマンド（serve --all-projects）で起動し、HTTP で確かめる: モード・一覧・作成（登録世代つき）と CLI から見た保存・
//      同じ ID の分離・添付・Docker のソケットが無いときのエンジンの状態（Preflight を使えない理由）・Mock の Preflight を
//      2つ同時に動かして片方を取り消す・データのフォルダの欠落と復旧・再起動のあとも残る・SIGTERM（docker stop）で止まる
//   4. コマンドを明示すると通常の serve（1つのプロジェクト）になる
//
// コンテナは root で動かし（イメージの既定）、--work をコンテナの中の同じパスにマウントする。
// DevContainer の中では、--work に Docker のホストから見えるフォルダを渡し、環境変数 P3_CODEX_PATH_MAP（このマシンのパス=ホストのパス）
// でマウントの元を決める。公開したポートが Docker のホストにしか開かない（DevContainer など）ときは、--network-of で
// このマシンのコンテナのネットワークに入れる（auto はこのコンテナを探す。ポートは公開せず P3_PORT で待ち受ける）。本物の Codex（ソケット・pathMap・ChatGPT の接続）はここでは確かめない（docs/development.md）。
// 依存を使わない（Node だけで動く）。CI には入れない。
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
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

const image = option("image") ?? "infodb-p3:verify";
const base = option("work") ? resolve(option("work")) : tmpdir();
mkdirSync(base, { recursive: true });
const work = mkdtempSync(join(base, "p3-verify-docker-"));
const tag = `p3-verify-${process.pid}`;
const containers = [];
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
const sh = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const docker = (...argv) => sh("docker", argv).trim();

/** このマシンのパス → Docker のホストのパス（P3_CODEX_PATH_MAP の a=b,c=d。無ければそのまま） */
const hostPath = (p) => {
  for (const pair of (process.env.P3_CODEX_PATH_MAP ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [from, to] = pair.split("=");
    if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
  }
  return p;
};

// 個人設定とプロジェクト（このマシンの p3 で作る。パスはコンテナの中でも同じ）
const config = join(work, "config");
const localEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_") && !k.startsWith("npm_"))),
  XDG_CONFIG_HOME: config,
  P3_ACTOR: "human:verify",
};
const p3 = (cwd, ...argv) => sh(process.execPath, [join(ROOT, "bin", "p3.mjs"), ...argv], { cwd, env: localEnv });
const repoOf = (n) => join(work, n);
const dataOf = (n) => join(repoOf(n), ".p3");

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

let port = 0;
const api = async (method, path, body, headers = {}) => {
  const init = body === undefined ? { method, headers } : { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const waitReady = async (path = "/mode") => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await api("GET", path);
      if (r.status === 200) return r.body;
    } catch {
      // まだ待ち受けていない
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`30 秒で起動しませんでした:\n${docker("logs", "--tail", "30", containers.at(-1))}`);
};
/** --network-of auto: このマシンが動いているコンテナ（mountinfo の /docker/containers/<id>） */
const networkOf = (() => {
  const v = option("network-of");
  if (v !== "auto") return v;
  const id = /\/docker\/containers\/([0-9a-f]{64})/.exec(readFileSync("/proc/self/mountinfo", "utf8"))?.[1];
  if (!id) throw new Error("--network-of auto: このマシンはコンテナの中ではないようです（--network-of を外すか、コンテナを指定してください）");
  return id;
})();
const run = (name, extra = [], cmd = []) => {
  containers.push(name);
  const net = networkOf ? ["--network", `container:${networkOf}`, "-e", `P3_PORT=${port}`] : ["-p", `127.0.0.1:${port}:4310`];
  // 明示したコマンドでも同じポートで待つ
  const cmdPort = networkOf && cmd.length ? [...cmd, "--port", String(port)] : cmd;
  docker("run", "-d", "--name", name, ...net, "-v", `${hostPath(work)}:${work}`, "-e", `XDG_CONFIG_HOME=${config}`, ...extra, image, ...cmdPort);
};

try {
  if (!flag("no-build")) {
    await step(`docker build（${image}）`, () => {
      const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
      execFileSync("docker", ["build", "-q", "--build-arg", `P3_VERSION=${version}`, "-t", image, ROOT], { stdio: ["ignore", "ignore", "inherit"] });
      return docker("image", "inspect", "--format", "{{.Id}}", image).slice(0, 19);
    });
  }

  await step("起動の約束（既定は serve --all-projects、exec の形の ENTRYPOINT）", () => {
    const entry = JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Entrypoint}}", image));
    const cmd = JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Cmd}}", image));
    check(JSON.stringify(entry) === '["p3"]', `ENTRYPOINT が違います: ${JSON.stringify(entry)}`);
    check(JSON.stringify(cmd) === '["serve","--all-projects","--host","0.0.0.0"]', `CMD が違います: ${JSON.stringify(cmd)}`);
    const tools = docker("run", "--rm", "--entrypoint", "sh", image, "-c", "node -v && docker --version && git --version");
    // root で動き、個人設定は root の既定の場所（開発コンテナと同じ）
    const who = docker("run", "--rm", "--entrypoint", "sh", image, "-c", 'id -u && echo "${XDG_CONFIG_HOME:-$HOME/.config}"');
    check(who === "0\n/root/.config", `root で動いていない・個人設定の場所が違います: ${who}`);
    const version = docker("image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.version"}}', image);
    return `${tools.split("\n").join(" / ")} / 版 ${version}`;
  });

  const ids = { rid: "" };
  await step("使い捨ての2つのプロジェクト（beta は alpha の写しで同じ ID）", () => {
    for (const n of ["alpha", "beta"]) {
      mkdirSync(repoOf(n), { recursive: true });
      sh("git", ["init", "-q", "-b", "main"], { cwd: repoOf(n) });
      sh("git", ["-c", "user.name=v", "-c", "user.email=v@example.com", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repoOf(n) });
    }
    p3(repoOf("alpha"), "init", "--yes", "--project", "alpha", "--description", "検証用");
    ids.rid = JSON.parse(p3(repoOf("alpha"), "request", "new", "共通の要望", "--body", "- 一つ目", "--json")).id;
    p3(repoOf("alpha"), "new", "共通のタスク", "--req", ids.rid);
    cpSync(dataOf("alpha"), dataOf("beta"), { recursive: true });
    p3(repoOf("beta"), "project", "add", "beta", dataOf("beta"));
    return work;
  });

  port = await freePort();
  await step("既定のコマンドで起動し、2つのプロジェクトを一覧にする", async () => {
    run(`${tag}-all`);
    const mode = await waitReady();
    check(mode.mode === "all-projects", `モードが違います: ${JSON.stringify(mode)}`);
    const l = (await api("GET", "/projects")).body;
    check(l.projects.map((p) => p.name).join(",") === "alpha,beta", `一覧が違います: ${JSON.stringify(l)}`);
    return l.projects.map((p) => `${p.name}(${p.state})`).join(", ");
  });

  const gen = async (n) => (await api("GET", "/projects")).body.projects.find((p) => p.name === n).generation;
  const at = async (n, method, path, body) => api(method, `/projects/${n}${path}`, body, { "x-p3-project-generation": await gen(n) });

  await step("作成・編集（登録世代つき）が手元のファイルに残り、同じ ID でも混ざらない", async () => {
    const made = await at("alpha", "POST", "/requests", { title: "コンテナから" });
    check(made.status === 201, `作成できません: ${JSON.stringify(made)}`);
    check(existsSync(join(dataOf("alpha"), "requests", made.body.id, "request.md")), "手元のデータのフォルダにありません");
    const patched = await at("alpha", "PATCH", `/requests/${ids.rid}/tasks/T001`, { title: "alpha で直した", rev: 1 });
    check(patched.status === 200, `直せません: ${JSON.stringify(patched)}`);
    const other = await at("beta", "GET", `/requests/${ids.rid}/tasks/T001`);
    check(other.body.task.title === "共通のタスク", `beta が変わっています: ${other.body.task.title}`);
    const noGen = await api("POST", "/projects/alpha/requests", { title: "世代なし" });
    check(noGen.status === 428, `登録世代なしの変更が通りました: ${noGen.status}`);
    return `${made.body.id}・T001 は alpha だけ`;
  });

  await step("添付はそのプロジェクトにだけ付く", async () => {
    const form = new FormData();
    // 1×1 の PNG
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    form.append("file", new Blob([png], { type: "image/png" }), "x.png");
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/alpha/requests/${ids.rid}/attachments`, {
      method: "POST",
      body: form,
      headers: { "x-p3-project-generation": await gen("alpha") },
    });
    const a = (await at("alpha", "GET", `/requests/${ids.rid}/attachments`)).body;
    const b = (await at("beta", "GET", `/requests/${ids.rid}/attachments`)).body;
    check(res.status === 201 && a.items.length === 1, `alpha に付きません: ${res.status} ${JSON.stringify(a)}`);
    check(b.items.length === 0, "beta に付いています");
    return `alpha ${a.items.length} 件（${res.status}）・beta 0 件`;
  });

  await step("Docker のソケットを渡していなければ、Preflight（Codex）を使えない理由を出す（Mock に落とさない）", async () => {
    const e = (await at("alpha", "GET", "/engine")).body;
    check(e.ok === false && e.name === "codex", `使えると出ています: ${JSON.stringify(e)}`);
    return e.detail.split("\n")[0];
  });

  await step("Mock の Preflight を2つ同時に動かし、片方を取り消しても他方は終わる", async () => {
    const runs = {};
    for (const n of ["alpha", "beta"]) {
      const r = await at(n, "POST", `/requests/${ids.rid}/preflight`, { engine: "mock" });
      check(r.status === 202, `${n} で始められません: ${JSON.stringify(r)}`);
      runs[n] = r.body.id;
    }
    await at("beta", "POST", `/requests/${ids.rid}/preflight/${runs.beta}/cancel`, {});
    const wait = async (n) => {
      for (let i = 0; i < 100; i++) {
        const r = (await at(n, "GET", `/requests/${ids.rid}/preflight/${runs[n]}`)).body;
        if (r.status !== "running") return r;
        await new Promise((x) => setTimeout(x, 200));
      }
      throw new Error(`${n} の Preflight が終わりません`);
    };
    const [a, b] = [await wait("alpha"), await wait("beta")];
    check(a.status === "completed", `alpha: ${a.status} ${a.error ?? ""}`);
    check(b.status === "failed" && b.error === "中止しました", `beta: ${b.status} ${b.error ?? ""}`);
    return `alpha completed・beta 中止しました`;
  });

  await step("再起動しても登録と作ったものが残る。データのフォルダが無いプロジェクトだけ開けず、戻せば開ける", async () => {
    renameSync(dataOf("beta"), `${dataOf("beta")}.moved`);
    docker("restart", "-t", "15", `${tag}-all`);
    await waitReady();
    const l = (await api("GET", "/projects")).body;
    check(l.projects.length === 2, `登録が残っていません: ${JSON.stringify(l)}`);
    const reqs = (await at("alpha", "GET", "/requests")).body.map((r) => r.request.title);
    check(reqs.includes("コンテナから"), `作ったものが残っていません: ${reqs.join(", ")}`);
    const gone = await at("beta", "GET", "/requests");
    check(gone.status === 503, `データの無い beta が開けてしまいました: ${gone.status}`);
    renameSync(`${dataOf("beta")}.moved`, dataOf("beta"));
    const back = await at("beta", "GET", "/requests");
    check(back.status === 200, `戻しても開けません: ${back.status}`);
    return `要望 ${reqs.length} 件・beta 503 → 200`;
  });

  await step("docker stop（SIGTERM）で、実行中の Preflight を取り消して止まる", async () => {
    // Mock は少し待つので、その間に止める
    const r = await at("alpha", "POST", `/requests/${ids.rid}/preflight`, { engine: "mock" });
    const t = Date.now();
    docker("stop", "-t", "15", `${tag}-all`);
    const took = Date.now() - t;
    const code = docker("inspect", "--format", "{{.State.ExitCode}}", `${tag}-all`);
    // serve の知らせは stderr に出る
    const logs = sh("sh", ["-c", `docker logs ${tag}-all 2>&1`]);
    check(code === "0", `終了コード ${code}`);
    check(took < 14_000, `止まるまで ${took}ms（SIGTERM を受けていない）`);
    check(logs.includes("SIGTERM を受けたので止めます"), `SIGTERM を受けた知らせがありません:\n${logs.slice(-500)}`);
    const run = JSON.parse(readFileSync(join(dataOf("alpha"), "requests", ids.rid, "preflight", r.body.id, "run.json"), "utf8"));
    check(run.status !== "running", `止めた run が実行中のまま残っています`);
    return `${took}ms・終了コード 0・止めた run は ${run.status}${run.error ? `（${run.error}）` : ""}`;
  });

  await step("コマンドを明示すると、通常の serve（1つのプロジェクト）になる", async () => {
    port = await freePort();
    run(`${tag}-single`, [], ["serve", "--dir", dataOf("alpha"), "--host", "0.0.0.0"]);
    const mode = await waitReady();
    check(mode.mode === "single", `モードが違います: ${JSON.stringify(mode)}`);
    check((await api("GET", "/requests")).status === 200, "通常の API が使えません");
    return JSON.stringify(mode);
  });
} catch {
  // 失敗は step が記録した
} finally {
  for (const c of containers) {
    try {
      execFileSync("docker", ["rm", "-f", c], { stdio: "ignore" });
    } catch {
      // 既に無い
    }
  }
  if (!flag("keep")) rmSync(work, { recursive: true, force: true });
}

const ok = results.every((r) => r.ok);
console.log(JSON.stringify({ ok, image, work: flag("keep") ? work : undefined, results, notVerified: ["本物の Codex（Docker のソケット・pathMap・ChatGPT の接続）での Preflight・画面資料の描画・要約の生成"] }, null, 2));
process.exit(ok ? 0 : 1);
