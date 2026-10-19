import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mapPath, pathMapHowTo } from "./diagnose.ts";

const exec = promisify(execFile);

/**
 * 画面イメージの描画（自己完結した HTML / CSS → PNG）。
 *
 * P3（ホストのプロセス）が専用のイメージ（render-image/）で docker run する。Codex のコンテナに Docker のソケットは渡さない。
 * 描画のコンテナは、ネットワークなし・認証情報なし・リポジトリなしで、確かめた原稿のコピー（/in。読むだけ）と
 * 出力のフォルダ（/out）だけをマウントする。ルートのファイルシステムは読むだけ、権限（capability）は全部外し、
 * メモリ・CPU・プロセス数・時間に上限を付ける。Chromium の sandbox は使わない（コンテナを囲いにする）。
 *
 * 原稿は描画の前に確かめる（checkHtml）: スクリプト・イベントの属性・javascript: URL・外のファイルや通信を指す参照・
 * iframe / object / embed / link / base / meta refresh は断る。参照に使えるのは data: の画像（PNG / JPEG / GIF / WebP / SVG）・
 * data: のフォント（woff2 / woff / ttf / otf）と、ページの中の #id だけ。描画するときもスクリプトは無効にし、
 * data: 以外の読み込みは止めて記録する（通信を止めるのは唯一の囲いではない）。
 */
export const RENDER_IMAGE_DIR = fileURLToPath(new URL("./render-image/", import.meta.url));

/** 上限 */
export const RENDER_LIMITS = {
  /** 1つの原稿の大きさ */
  htmlBytes: 2 * 1024 * 1024,
  /** 1回の描画の数 */
  pages: 20,
  minWidth: 320,
  maxWidth: 2560,
  maxHeight: 16384,
  /** 1ページあたりの時間（ブラウザの中） */
  pageTimeoutMs: 20_000,
  /** 1回の docker run 全体の時間 = base + ページ数 × perPage */
  baseTimeoutMs: 60_000,
  perPageTimeoutMs: 25_000,
  memory: "1g",
  cpus: "1",
  pids: 256,
} as const;

export class RenderError extends Error {
  constructor(
    message: string,
    readonly step: "check" | "docker" | "image" | "run" | "timeout" | "cancel",
  ) {
    super(message);
  }
}

// --- 原稿の確かめ ----------------------------------------------------------

const DATA_OK = /^data:(image\/(png|jpeg|gif|webp|svg\+xml)|font\/(woff2?|ttf|otf)|application\/(font-woff2?|x-font-ttf|x-font-otf))[;,]/i;

/** 参照の値として認めるか（data: の画像・フォント、ページの中の #id） */
function refOk(v: string): boolean {
  const s = v.trim().replace(/^['"]|['"]$/g, "").trim();
  return !s || s.startsWith("#") || DATA_OK.test(s);
}

/**
 * 原稿を確かめる。問題（理由）の一覧を返す（空なら描画してよい）。
 * HTML を完全に解析するのではなく、危ないものを広めに断る（読み込みを止める囲いと、コンテナの囲いがその後ろにある）
 */
export function checkHtml(html: string): string[] {
  const problems: string[] = [];
  const add = (p: string) => problems.includes(p) || problems.push(p);
  if (Buffer.byteLength(html) > RENDER_LIMITS.htmlBytes) add(`原稿が大きすぎます（上限 ${RENDER_LIMITS.htmlBytes} バイト）`);
  // コメントは参照の判定から外す（中身は描画されない）
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  if (/<\s*script\b/i.test(body)) add("スクリプト（<script>）は使えません");
  for (const tag of ["iframe", "frame", "frameset", "object", "embed", "applet", "link", "base", "portal"]) {
    if (new RegExp(`<\\s*${tag}\\b`, "i").test(body)) add(`<${tag}> は使えません`);
  }
  if (/<\s*meta\b[^>]*http-equiv/i.test(body)) add("<meta http-equiv> は使えません");
  if (/<[^>]*\son[a-z]+\s*=/i.test(body)) add("イベントの属性（onclick など）は使えません");
  if (/javascript\s*:/i.test(body) || /vbscript\s*:/i.test(body)) add("javascript: の URL は使えません");
  // 属性の参照（src / href / srcset / poster / action / formaction / data / background / xlink:href）
  const attr = /\s(?:xlink:)?(src|href|srcset|poster|action|formaction|data|background|manifest|ping|cite|longdesc|lowsrc|dynsrc)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
  for (const m of body.matchAll(attr)) {
    const name = m[1].toLowerCase();
    const value = m[2].replace(/^['"]|['"]$/g, "");
    // srcset は「URL 記述子, URL 記述子」。data: の URL にも , が入るので、空白で分けて記述子（1x・640w）以外を見る
    const values =
      name === "srcset"
        ? value
            .split(/\s+/)
            .map((x) => x.replace(/^,+|,+$/g, ""))
            .filter((x) => x && !/^\d+(\.\d+)?[wx]$/.test(x))
        : [value];
    for (const v of values) if (!refOk(v)) add(`外のファイル・通信を指す参照は使えません: ${name}="${v.slice(0, 80)}"`);
  }
  // CSS の参照（url(...) と @import）
  for (const m of body.matchAll(/url\(\s*("[^"]*"|'[^']*'|[^)]*)\s*\)/gi)) {
    if (!refOk(m[1])) add(`外のファイル・通信を指す参照は使えません: url(${m[1].slice(0, 80)})`);
  }
  if (/@import\b/i.test(body)) add("@import は使えません（CSS は <style> の中に書いてください）");
  if (/image-set\(|expression\(|-moz-binding|behavior\s*:/i.test(body)) add("image-set() / expression() などは使えません");
  return problems;
}

// --- イメージ ----------------------------------------------------------------

/** イメージの資材（render-image/ の中。全部をイメージの名前の hash に入れる） */
export const RENDER_IMAGE_FILES = ["Dockerfile", "fonts-ja.conf", "render.mjs"] as const;

/** イメージの名前（資材の中身から決める。どれかが変われば別の名前になり、作り直す） */
export async function renderImageTag(dir = RENDER_IMAGE_DIR): Promise<string> {
  const h = createHash("sha256");
  for (const f of RENDER_IMAGE_FILES) h.update(await readFile(join(dir, f)));
  return `infodb-p3-render:${h.digest("hex").slice(0, 12)}`;
}

export interface RenderOptions {
  docker?: string;
  /** このマシンのパス → Docker デーモンから見たパス（codex.pathMap） */
  pathMap?: readonly [string, string][];
  /** 使うイメージ（無ければ renderImageTag） */
  image?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

/** Docker が使えるか（使えなければ RenderError） */
export async function checkDocker(docker = "docker"): Promise<string> {
  try {
    const { stdout } = await exec(docker, ["version", "--format", "{{.Server.Version}}"], { timeout: 15_000 });
    return stdout.trim();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") throw new RenderError("docker コマンドが見つかりません。Docker をインストールしてください", "docker");
    const detail = (err.stderr ?? err.message).trim().split("\n").pop();
    throw new RenderError(`Docker デーモンにつながりません（${detail}）。Docker を起動してください`, "docker");
  }
}

/** 描画のイメージが無ければ作る。force なら作り直す。イメージの名前を返す */
export async function ensureRenderImage(opts: RenderOptions & { force?: boolean } = {}): Promise<{ image: string; built: boolean }> {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? (await renderImageTag());
  await checkDocker(docker);
  if (!opts.force) {
    const has = await exec(docker, ["image", "inspect", "--format", "{{.Id}}", image], { timeout: 15_000 }).then(
      () => true,
      () => false,
    );
    if (has) return { image, built: false };
  }
  opts.onProgress?.(`描画のイメージ ${image} を作ります（初回は数分かかります）`);
  // ビルドのコンテキストは docker の CLI が送るので、パスの対応は要らない
  const out = await runProcess(docker, ["build", ...(opts.force ? ["--pull", "--no-cache"] : []), "-t", image, RENDER_IMAGE_DIR], { timeoutMs: 20 * 60_000, signal: opts.signal });
  if (out.code !== 0) throw new RenderError(`描画のイメージを作れません: ${lastLine(out.stderr)}`, "image");
  return { image, built: true };
}

// --- 描画 --------------------------------------------------------------------

export interface RenderJob {
  /** 出力の名前（<id>.png） */
  id: string;
  /** 原稿の中身 */
  html: string;
  /** 画面の幅（px） */
  width: number;
}

export interface RenderResult {
  id: string;
  ok: boolean;
  /** できた PNG（ok のとき。出力のフォルダの中） */
  file?: string;
  error?: string;
  /** 縦に長すぎて上から切った */
  clipped?: boolean;
  /** 止めた読み込み */
  blocked: string[];
}

/** docker run の引数（テストで確かめる） */
export function renderArgs(p: { image: string; name: string; hostIn: string; hostOut: string }): string[] {
  return [
    "run",
    "--rm",
    "--name",
    p.name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(RENDER_LIMITS.pids),
    "--memory",
    RENDER_LIMITS.memory,
    "--cpus",
    RENDER_LIMITS.cpus,
    "--shm-size",
    "256m",
    "--tmpfs",
    "/tmp:rw,size=256m",
    "-e",
    `P3_RENDER_MAX_HEIGHT=${RENDER_LIMITS.maxHeight}`,
    "-e",
    `P3_RENDER_PAGE_TIMEOUT=${RENDER_LIMITS.pageTimeoutMs}`,
    "--mount",
    `type=bind,src=${p.hostIn},dst=/in,readonly`,
    "--mount",
    `type=bind,src=${p.hostOut},dst=/out`,
    p.image,
  ];
}

/**
 * 原稿を PNG にする。workDir（このマシンのパス。Docker デーモンから見えるところ）の下に一時のフォルダを作り、
 * 終わったら（失敗・時間切れ・取消でも）コンテナを止めて消す。できた PNG は outDir に <id>.png で置く。
 * 原稿に問題があるものは描画せずに結果に理由を返す
 */
export async function renderHtml(jobs: RenderJob[], workDir: string, outDir: string, opts: RenderOptions = {}): Promise<RenderResult[]> {
  const docker = opts.docker ?? "docker";
  if (jobs.length > RENDER_LIMITS.pages) throw new RenderError(`一度に描画できるのは ${RENDER_LIMITS.pages} 枚までです`, "check");
  const results = new Map<string, RenderResult>();
  const ok: RenderJob[] = [];
  for (const j of jobs) {
    const problems = [...checkHtml(j.html)];
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(j.id)) problems.push(`名前が使えません: ${j.id}`);
    if (!Number.isInteger(j.width) || j.width < RENDER_LIMITS.minWidth || j.width > RENDER_LIMITS.maxWidth) {
      problems.push(`幅は ${RENDER_LIMITS.minWidth}〜${RENDER_LIMITS.maxWidth} px にしてください: ${j.width}`);
    }
    if (problems.length) results.set(j.id, { id: j.id, ok: false, error: problems.join(" / "), blocked: [] });
    else ok.push(j);
  }
  if (ok.length) {
    const { image } = await ensureRenderImage({ ...opts, docker });
    const tmp = join(workDir, `.render-${randomBytes(4).toString("hex")}`);
    const name = `p3-render-${randomBytes(4).toString("hex")}`;
    try {
      await mkdir(join(tmp, "in"), { recursive: true });
      await mkdir(join(tmp, "out"), { recursive: true });
      // コンテナの中の利用者（root ではない）が書けるように
      await chmod(join(tmp, "out"), 0o777);
      for (const j of ok) await writeFile(join(tmp, "in", `${j.id}.html`), j.html);
      await writeFile(join(tmp, "in", "jobs.json"), JSON.stringify(ok.map((j) => ({ id: j.id, file: `${j.id}.html`, width: j.width }))));
      const host = (p: string) => mapPath(opts.pathMap ?? [], p).host;
      const args = renderArgs({ image, name, hostIn: host(join(tmp, "in")), hostOut: host(join(tmp, "out")) });
      opts.onProgress?.(`${ok.length} 枚を描画します`);
      const timeoutMs = RENDER_LIMITS.baseTimeoutMs + ok.length * RENDER_LIMITS.perPageTimeoutMs;
      const out = await runProcess(docker, args, { timeoutMs, signal: opts.signal, onStop: () => exec(docker, ["kill", name]).catch(() => {}) });
      if (out.stopped === "cancel") throw new RenderError("描画を取り消しました", "cancel");
      if (out.stopped === "timeout") throw new RenderError(`描画が ${Math.round(timeoutMs / 1000)} 秒で終わりませんでした`, "timeout");
      if (out.code !== 0) throw new RenderError(diagnoseRender(out.stderr, opts.pathMap ?? [], workDir), "run");
      const reported = parseReport(out.stdout);
      await mkdir(outDir, { recursive: true });
      for (const j of ok) {
        const r = reported.find((x) => x.id === j.id);
        if (!r?.ok) {
          results.set(j.id, { id: j.id, ok: false, error: r?.error ?? "描画の結果がありません", blocked: r?.blocked ?? [] });
          continue;
        }
        const file = join(outDir, `${j.id}.png`);
        await copyFile(join(tmp, "out", `${j.id}.png`), file);
        results.set(j.id, { id: j.id, ok: true, file, clipped: !!r.clipped, blocked: r.blocked ?? [] });
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  return jobs.map((j) => results.get(j.id)!);
}

function parseReport(stdout: string): { id: string; ok: boolean; error?: string; clipped?: boolean; blocked?: string[] }[] {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const r = JSON.parse(line);
    return Array.isArray(r.results) ? r.results : [];
  } catch {
    throw new RenderError(`描画の結果が読めません: ${line.slice(0, 200)}`, "run");
  }
}

const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).pop() ?? "（出力なし）";

/** docker run の失敗の説明（よくある原因には次にすることを添える） */
export function diagnoseRender(stderr: string, pathMap: readonly [string, string][], workDir?: string): string {
  const last = lastLine(stderr);
  if (/bind source path does not exist|invalid mount config|not a directory|no such file or directory/i.test(stderr)) {
    const m = workDir ? mapPath(pathMap, workDir) : undefined;
    return [
      `描画のコンテナに原稿のフォルダをマウントできません（${last}）。DevContainer の中から使うときは、パスの対応（codex.pathMap）が要ります`,
      ...pathMapHowTo(m && { label: "描画", local: workDir!, host: m.host, rule: m.rule, container: "/in" }),
    ].join("\n");
  }
  if (/permission denied/i.test(stderr) && /docker\.sock|daemon/i.test(stderr)) return `Docker を使う権限がありません（${last}）`;
  if (/Unable to find image|pull access denied/i.test(stderr)) return `描画のイメージがありません（${last}）。p3 render --update で作り直してください`;
  return `描画に失敗しました: ${last}`;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  stopped?: "timeout" | "cancel";
}

/** 子プロセスを動かす。時間切れ・取消のときは onStop（コンテナを止める）を呼んでからプロセスを終わらせる */
function runProcess(cmd: string, args: string[], o: { timeoutMs: number; signal?: AbortSignal; onStop?: () => Promise<unknown> }): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stopped: ProcessResult["stopped"];
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-1_000_000)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-100_000)));
    const stop = (why: NonNullable<ProcessResult["stopped"]>) => {
      if (stopped) return;
      stopped = why;
      void (o.onStop?.() ?? Promise.resolve()).finally(() => child.kill("SIGKILL"));
    };
    const timer = setTimeout(() => stop("timeout"), o.timeoutMs);
    const onAbort = () => stop("cancel");
    if (o.signal?.aborted) onAbort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, stopped });
    };
    child.on("error", (e) => {
      stderr += String(e.message);
      done(-1);
    });
    child.on("close", done);
  });
}

