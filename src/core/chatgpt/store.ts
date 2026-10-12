import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "../store/fsutil.ts";
import { userConfigPath } from "../userConfig.ts";
import type { TokenSet } from "./oauth.ts";

/**
 * ChatGPT との接続（このマシン・この人だけ。共有しない）。個人設定と同じ場所の別ファイルに置く:
 *
 *   ~/.config/infodb-p3/chatgpt.json   0600。秘密（トークン）を含む
 *   ~/.config/infodb-p3/chatgpt.lock   トークンの更新の排他
 *
 * config.yaml（プロジェクト・画面の設定）とは別のファイルなので、どちらを保存してももう一方は消えない。
 */
export interface Connection {
  /** このマシンの登録に使う ID（ext_agent_host_id）。一度作ったらずっと使う */
  hostId: string;
  /** 発行された client ID（oaiapp_…）。初回のサインインで決まる */
  clientId?: string;
  /** 検証した ID トークンのアカウント */
  account?: { sub: string; email?: string };
  /** 解除すると消える（登録とアカウントは残す） */
  tokens?: TokenSet & { savedAt: string };
}

export const connectionPath = () => join(dirname(userConfigPath()), "chatgpt.json");
const lockPath = (file: string) => file.replace(/\.json$/, ".lock");

export async function loadConnection(file = connectionPath()): Promise<Connection | undefined> {
  const text = await readFile(file, "utf8").catch(() => "");
  if (!text.trim()) return undefined;
  try {
    const c = JSON.parse(text) as Connection;
    return typeof c.hostId === "string" ? c : undefined;
  } catch {
    return undefined;
  }
}

/** 無ければホスト ID だけの接続を作る（まだ保存しない） */
export async function loadOrNew(file = connectionPath()): Promise<Connection> {
  return (await loadConnection(file)) ?? { hostId: `urn:uuid:${randomUUID()}` };
}

/** 一時ファイルも含めて所有者だけが読み書きできるように書き、rename で置き換える */
export async function saveConnection(c: Connection, file = connectionPath()): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(c, null, 2)}\n`, "utf8");
  } finally {
    await fh.close();
  }
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

export async function removeConnection(file = connectionPath()): Promise<void> {
  await rm(file, { force: true });
}

/** 更新日時（serve が接続の変化に気付くため） */
export async function connectionMtime(file = connectionPath()): Promise<number> {
  return (await stat(file).catch(() => undefined))?.mtimeMs ?? 0;
}

/**
 * 同じマシンの CLI・serve・並行する Preflight で、トークンの更新を1つずつ行う（refresh token は使うと入れ替わるため）。
 * lock を取れなければ少し待つ。古い lock（staleMs より前）は落ちたプロセスのものとして取り直す。
 */
export function withLock<T>(fn: () => Promise<T>, file = connectionPath(), opts = { timeoutMs: 30_000, staleMs: 60_000 }): Promise<T> {
  return withFileLock(lockPath(file), fn, { ...opts, busyMessage: "ChatGPT の接続の更新を待ちきれませんでした（別のプロセスが更新中です）" });
}
