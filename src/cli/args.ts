import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { ATTACHMENT_LIMITS, AttachmentError, inspectAttachment } from "../core/store/attachments.ts";
import { type Task, TASK_STATUSES, isTaskStatus, type TaskStatus } from "../shared/types.ts";
import { type P3Context } from "../core/context.ts";
import { repoArg } from "../core/workTargets.ts";
import { UsageError } from "./project.ts";
import { Output } from "./output.ts";

/** CLI の入力の解釈（オプション・キー=値・本文・添付のファイル）と、コマンドに渡すもの（CommandEnv） */

const OPTIONS = {
  dir: { type: "string" },
  project: { type: "string" },
  "all-projects": { type: "boolean" },
  req: { type: "string" },
  request: { type: "string" },
  json: { type: "boolean" },
  brief: { type: "boolean" },
  actor: { type: "string" },
  rev: { type: "string" },
  help: { type: "boolean", short: "h" },
  all: { type: "boolean" },
  status: { type: "string" },
  area: { type: "string", multiple: true },
  label: { type: "string", multiple: true },
  output: { type: "string", multiple: true },
  "repo-output": { type: "string", multiple: true },
  q: { type: "string", short: "q" },
  due: { type: "string" },
  milestone: { type: "string" },
  parent: { type: "string" },
  tag: { type: "string", multiple: true },
  attach: { type: "string", multiple: true },
  title: { type: "string" },
  done: { type: "boolean" },
  off: { type: "boolean" },
  body: { type: "string" },
  record: { type: "string" },
  note: { type: "string" },
  engine: { type: "string" },
  run: { type: "string" },
  only: { type: "string" },
  skip: { type: "string" },
  name: { type: "string" },
  repo: { type: "string" },
  description: { type: "string" },
  instructions: { type: "string" },
  // 値なしの --agents は both（joinValues が --agents=both にする）
  agents: { type: "string" },
  force: { type: "boolean" },
  "note-only": { type: "boolean" },
  "archive-superseded": { type: "boolean" },
  paste: { type: "boolean" },
  "no-browser": { type: "boolean" },
  forget: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  local: { type: "boolean" },
  "repo-name": { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  out: { type: "string" },
  source: { type: "string" },
  width: { type: "string" },
  version: { type: "string" },
  file: { type: "string" },
  "based-on": { type: "string" },
} as const;

export const parse = (argv: string[]) => parseArgs({ args: joinValues(argv), options: OPTIONS, allowPositionals: true });

/** `--body "- 箇条書き"` のように値が - で始まっても受け取れるよう、`--body=...` の形にまとめる */
function joinValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const name = /^--([a-z]+)$/.exec(argv[i])?.[1];
    const opt = name ? (OPTIONS as Record<string, { type: string }>)[name] : undefined;
    if (name === "agents") {
      // 値は省ける（both）。次がオプション（- で始まる）か無ければ値なし。値は確かめる側（init）で断る
      const next = argv[i + 1];
      out.push(next !== undefined && !next.startsWith("-") ? `--agents=${argv[++i]}` : "--agents=both");
    } else if (opt?.type === "string" && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out.push(`${argv[i]}=${argv[++i]}`);
    } else {
      out.push(argv[i]);
    }
  }
  return out;
}

// --- 入力 -----------------------------------------------------------------

const TASK_KEYS = ["title", "status", "labels", "areas", "outputs", "repo", "repoOutputs"];

export function parseTaskAssignments(pairs: string[]): Partial<Task> {
  const patch: Record<string, unknown> = {};
  for (const pair of pairs) {
    const [key, raw] = splitPair(pair);
    if (!TASK_KEYS.includes(key)) throw new UsageError(`変更できるキー: ${TASK_KEYS.join(", ")}`);
    if (key === "repo") {
      // repo=<名前> / repo=none・repo= は作業先なし
      patch.repo = repoArg(raw);
      continue;
    }
    if (key === "repoOutputs") {
      if (raw !== "") throw new UsageError("repoOutputs= は空で全部外すだけ。足すときは --repo-output <名前>=<成果物>");
      patch.repoOutputs = [];
      continue;
    }
    if (raw === "") {
      patch[key] = key === "labels" || key === "areas" || key === "outputs" ? [] : undefined;
      continue;
    }
    if (key === "labels" || key === "areas" || key === "outputs") patch[key] = list(raw);
    else if (key === "status") {
      checkStatus(raw);
      patch[key] = raw;
    } else patch[key] = raw;
  }
  return patch;
}

export function splitPair(pair: string): [string, string] {
  const eq = pair.indexOf("=");
  if (eq < 1) throw new UsageError(`キー=値 の形で指定してください: ${pair}`);
  return [pair.slice(0, eq), pair.slice(eq + 1).trim()];
}

export function checkStatus(status: string | undefined): asserts status is TaskStatus {
  if (!isTaskStatus(status)) throw new UsageError(`ステータスは ${TASK_STATUSES.join(", ")} のいずれか`);
}

export const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function num(v: string, name: string) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`${name} は数値で指定してください`);
  return n;
}

export function date(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UsageError(`日付は YYYY-MM-DD: ${v}`);
  return v;
}

export function readBody(v: string | undefined): string {
  if (v === undefined) return "";
  return v === "-" ? readFileSync(0, "utf8") : v;
}

/** request new --attach のファイルを読み、要望を作る前に全部確かめる（1つでもだめなら作らない） */
export async function readAttachFiles(paths: string[]): Promise<{ path: string; data: Buffer }[]> {
  if (paths.length > ATTACHMENT_LIMITS.count) throw new UsageError(`添付は1つの要望に ${ATTACHMENT_LIMITS.count} 件までです`);
  const files = [];
  for (const path of paths) {
    const data = await readFile(resolvePath(process.cwd(), path)).catch(() => {
      throw new UsageError(`ファイルが読めません: ${path}`);
    });
    try {
      inspectAttachment(data, basename(path));
    } catch (e) {
      throw e instanceof AttachmentError ? new UsageError(`${path}: ${e.message}（要望は作っていません）`) : e;
    }
    files.push({ path, data });
  }
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > ATTACHMENT_LIMITS.totalBytes) throw new UsageError(`添付の合計が上限（${ATTACHMENT_LIMITS.totalBytes} バイト）を超えます（要望は作っていません）`);
  return files;
}

/** コマンドに渡すもの（main がプロジェクト・変更者・今の要望を決めてから渡す） */
export interface CommandEnv {
  ctx: P3Context;
  out: Output;
  args: string[];
  o: ReturnType<typeof parse>["values"];
  actor: string;
  current: string | undefined;
  expectedRev: number | undefined;
  requestArg: (raw: string | undefined) => string;
  taskArg: (raw: string | undefined) => string;
  split: (ref: string) => { col: ReturnType<P3Context["ws"]["tasksOf"]>; rid: string; tid: string };
  cwd: string;
  target: { name?: string; dataDir: string };
}
