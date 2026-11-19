#!/usr/bin/env node
// マウントするパスの自動の決め方（src/core/preflight/hostPaths.ts）を、本物の Docker で確かめる（261115-d0n30/T003）。
//
//   node scripts/verify-host-paths.mjs [--image <名前>] [--no-build] [--work <フォルダ>] [--host-work <ホストのパス>] [--keep]
//
//   A. このマシン（DevContainer など）: codex.pathMap の無い使い捨ての個人設定で
//      - p3 user-config paths が、リポジトリとデータ（別々のフォルダ）を自動で決める
//      - bind の下の原稿を p3 render で PNG にする（描画のコンテナに自動で決めたパスをマウントする）
//      - コンテナの中だけにある原稿（/tmp）は、描画のコンテナを起こさずに止まる
//   B. Dockerfile のイメージ（tamuto/p3 と同じ作り）: ホストのソケットを渡し、リポジトリとデータを「中と外で違うパス」の別々の
//      bind に、ほかに名前付きボリュームを付け、ホスト名をコンテナの名前と変えて起こす。中の p3（codex.pathMap なし）で
//      - p3 user-config paths が、自分のコンテナを確かめて別々の bind からホストのパスを決め、volume は止める
//      - bind の下の原稿を p3 render で PNG にする / volume の下の原稿と、繋がらない DOCKER_HOST は描画のコンテナを起こさずに止まる
//
// 検証する p3 には codex.pathMap も P3_CODEX_PATH_MAP も渡さない（製品の自動の決め方だけで動くか）。外側の準備（B のコンテナに
// 付けるホストのパス）だけは --host-work か P3_CODEX_PATH_MAP（a=b,c=d）で決め、どちらも無ければこのマシンの p3 の自動の結果を使う
// （そのときは出力に書く）。--work は Docker のホストから見える（bind の下の）フォルダにする（既定はこのリポジトリの親）。
// 本物の Codex の Preflight（ChatGPT のプランを使う）はここでは動かさない。人が p3 preflight で確かめる（docs/development.md）。
// 依存を使わない（Node だけで動く）。CI には入れない。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const image = option("image") ?? "infodb-p3:verify-host-paths";
const base = resolve(option("work") ?? dirname(ROOT));
const work = mkdtempSync(join(base, ".p3-verify-host-paths-"));
const tag = `p3-verify-hp-${process.pid}`;
const results = [];
const cleanup = [];

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
const docker = (...argv) => execFileSync("docker", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** P3_* を外し、使い捨ての個人設定（codex.pathMap なし）で動かす */
const cleanEnv = (config) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_") && !k.startsWith("npm_"))),
  XDG_CONFIG_HOME: config,
});
const runLocal = (argv, config) => spawnSync(process.execPath, [join(ROOT, "packages", "p3", "bin", "p3.mjs"), ...argv], { encoding: "utf8", env: cleanEnv(config) });
const PAGE = '<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><h1>パスの自動の確認</h1></body></html>';
const isPng = (f) => existsSync(f) && readFileSync(f).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

/** f の間に作られた描画のコンテナ（p3-render-*）の数（docker events で数える） */
async function renderContainersDuring(f) {
  const since = docker("system", "info", "--format", "{{.SystemTime}}");
  const r = await f();
  const until = docker("system", "info", "--format", "{{.SystemTime}}");
  const names = docker("events", "--since", since, "--until", until, "--filter", "type=container", "--filter", "event=create", "--format", "{{.Actor.Attributes.name}}");
  return { r, created: names.split("\n").filter((n) => n.startsWith("p3-render-")).length };
}

/** 外側の準備: このマシンのパス → ホストのパス（検証する p3 の設定には使わない） */
function outerHostPath(p) {
  const given = option("host-work");
  if (given) return { host: given + p.slice(work.length), how: "--host-work" };
  for (const pair of (process.env.P3_CODEX_PATH_MAP ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [from, to] = pair.split("=");
    if (p === from || p.startsWith(`${from}/`)) return { host: to + p.slice(from.length), how: "P3_CODEX_PATH_MAP" };
  }
  const out = runLocal(["user-config", "paths", p, "--json"], join(work, "config-outer"));
  const r = JSON.parse(out.stdout).paths[0];
  check(r.ok, `外側の準備: ${p} のホストのパスが分かりません（--host-work で渡してください）: ${r.detail}`);
  return { host: r.host, how: `このマシンの p3 の自動（${r.origin}）` };
}

try {
  const repo = join(work, "repo");
  const data = join(work, "data");
  for (const d of [repo, data, join(work, "config-a")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(repo, "page.html"), PAGE);

  // --- A. このマシン ---------------------------------------------------------------------------------------------
  const configA = join(work, "config-a");
  await step("A1 このマシン: user-config paths（codex.pathMap なし）", () => {
    const out = runLocal(["user-config", "paths", repo, data, "--json"], configA);
    check(out.status === 0, out.stderr);
    const r = JSON.parse(out.stdout);
    check(r.ok, `決まらないものがあります: ${JSON.stringify(r.paths)}`);
    return `動いている場所 ${r.environment.kind}、由来 ${r.paths.map((p) => p.origin).join("・")}`;
  });
  await step("A2 このマシン: bind の下の原稿を p3 render で PNG にする", async () => {
    const { r, created } = await renderContainersDuring(() => runLocal(["render", join(repo, "page.html"), "--out", join(repo, "page-a.png")], configA));
    check(r.status === 0, `${r.stdout}\n${r.stderr}`);
    check(isPng(join(repo, "page-a.png")), "PNG ができていません");
    return `描画のコンテナ ${created} 個`;
  });
  await step("A3 このマシン: コンテナの中だけの原稿は描画のコンテナを起こさずに止まる", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "p3-verify-hp-"));
    cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
    writeFileSync(join(tmp, "page.html"), PAGE);
    const { r, created } = await renderContainersDuring(() => runLocal(["render", join(tmp, "page.html"), "--out", join(tmp, "page.png")], configA));
    // このマシンがコンテナの外なら、そのまま渡して描ける（止まらない）
    const env = JSON.parse(runLocal(["user-config", "paths", tmp, "--json"], configA).stdout).environment.kind;
    if (env === "direct") return "このマシンはコンテナの外なので確かめない";
    check(r.status !== 0 && /決められないので、コンテナを起こしません/.test(r.stderr + r.stdout), `止まっていません:\n${r.stdout}\n${r.stderr}`);
    check(created === 0, `描画のコンテナを ${created} 個起こしました`);
    return (r.stderr + r.stdout).split("\n").find((l) => l.startsWith("次にすること")) ?? "";
  });

  // --- B. Dockerfile のイメージ --------------------------------------------------------------------------------------
  if (!flag("no-build")) {
    await step(`B0 docker build（${image}）`, () => {
      const version = JSON.parse(readFileSync(join(ROOT, "packages", "p3", "package.json"), "utf8")).version;
      execFileSync("docker", ["build", "-q", "--pull", "--build-arg", `P3_VERSION=${version}`, "-t", image, ROOT], { stdio: ["ignore", "ignore", "inherit"] });
      return docker("image", "inspect", "--format", "{{.Id}}", image).slice(0, 19);
    });
  }
  const hostRepo = outerHostPath(repo);
  const hostData = outerHostPath(data);
  const volume = `${tag}-vol`;
  const name = `${tag}-p3`;
  await step("B1 イメージを起こす（中と外で違うパスの bind 2つ・名前付きボリューム・ソケット・コンテナの名前と違うホスト名）", () => {
    docker("volume", "create", volume);
    cleanup.push(() => docker("volume", "rm", "-f", volume));
    docker(
      "run", "-d", "--name", name, "--hostname", "verify-host", "--entrypoint", "sleep",
      "-v", `${hostRepo.host}:/inner/repo`, "-v", `${hostData.host}:/elsewhere/data`, "-v", `${volume}:/vol`,
      "-v", "/var/run/docker.sock:/var/run/docker.sock", "--tmpfs", "/cfg", image, "infinity",
    );
    cleanup.push(() => docker("rm", "-f", name));
    return `外側の準備のホストのパス: ${hostRepo.how}`;
  });
  const inner = (argv, env = []) =>
    spawnSync("docker", ["exec", "-e", "XDG_CONFIG_HOME=/cfg", ...env.flatMap((e) => ["-e", e]), name, "p3", ...argv], { encoding: "utf8" });
  await step("B2 イメージの中: user-config paths が自分のコンテナを確かめ、別々の bind から決め、volume は止める", () => {
    docker("exec", name, "sh", "-c", `printf '%s' '${PAGE}' > /vol/page.html`);
    const out = inner(["user-config", "paths", "/inner/repo", "/elsewhere/data", "/vol", "--json"]);
    check(out.status === 0, out.stderr);
    const r = JSON.parse(out.stdout);
    check(r.environment.kind === "container", `自分のコンテナを確かめられません: ${JSON.stringify(r.environment)}`);
    const [a, b, v] = r.paths;
    check(a.ok && a.origin === "auto" && a.host === hostRepo.host, `リポジトリ: ${JSON.stringify(a)}`);
    check(b.ok && b.origin === "auto" && b.host === hostData.host, `データ: ${JSON.stringify(b)}`);
    check(!v.ok && v.reason === "not-bind", `volume: ${JSON.stringify(v)}`);
    return "リポジトリ・データ auto、volume not-bind";
  });
  await step("B3 イメージの中: bind の下の原稿を p3 render で PNG にする（codex.pathMap なし）", async () => {
    const { r, created } = await renderContainersDuring(() => inner(["render", "/inner/repo/page.html", "--out", "/inner/repo/page-b.png"]));
    check(r.status === 0, `${r.stdout}\n${r.stderr}`);
    check(isPng(join(repo, "page-b.png")), "PNG がホストのフォルダにできていません");
    return `描画のコンテナ ${created} 個`;
  });
  await step("B4 イメージの中: volume の下の原稿と、繋がらない DOCKER_HOST は描画のコンテナを起こさずに止まる", async () => {
    const vol = await renderContainersDuring(() => inner(["render", "/vol/page.html", "--out", "/vol/page.png"]));
    check(vol.r.status !== 0 && /決められないので、コンテナを起こしません/.test(vol.r.stderr + vol.r.stdout), `volume で止まっていません:\n${vol.r.stdout}\n${vol.r.stderr}`);
    check(vol.created === 0, `volume: 描画のコンテナを ${vol.created} 個起こしました`);
    const remote = inner(["user-config", "paths", "/inner/repo", "--json"], ["DOCKER_HOST=tcp://127.0.0.1:1"]);
    const rr = JSON.parse(remote.stdout);
    check(!rr.ok && rr.paths[0].reason === "inspect-failed", `繋がらない DOCKER_HOST: ${JSON.stringify(rr.paths[0])}`);
    return `volume: ${(vol.r.stderr + vol.r.stdout).split("\n").find((l) => l.startsWith("次にすること")) ?? ""} / DOCKER_HOST: ${rr.paths[0].reason}`;
  });
} catch {
  process.exitCode = 1;
} finally {
  for (const f of cleanup.reverse()) {
    try {
      f();
    } catch {
      // 片付けの失敗は結果に影響させない
    }
  }
  if (!flag("keep")) rmSync(work, { recursive: true, force: true });
  else process.stderr.write(`残しました: ${work}\n`);
  const left = docker("ps", "-a", "--filter", "label=infodb.p3", "--format", "{{.Names}}");
  if (left) process.stderr.write(`P3 のラベルのコンテナが残っています: ${left}\n`);
  process.stderr.write(`\n${results.filter((r) => r.ok).length}/${results.length} 通過\n`);
}
