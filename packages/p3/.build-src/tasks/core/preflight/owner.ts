import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type { RunOwner } from "../../shared/types.ts";

/**
 * Preflight の run を実行しているプロセス（所有者）の記録と、そのプロセスが今も動いているかの判定。
 * serve・CLI が落ちて running のまま残った run を、35 分を待たずに中断にするため（service.ts の recover）。
 *
 * 記録（run.json の owner。共有するデータに置くので、パス・認証情報・ホスト名そのものは残さない）:
 *   - instance: このマシン（コンテナ）の不透明な識別子。ローカルの状態のフォルダ（XDG_STATE_HOME/infodb-p3/instance-id。
 *     既定は ~/.local/state）に一度だけ作るランダムな値と、ホスト名から作るハッシュ。データ・個人設定（~/.config）とは別の場所に置く
 *     （個人設定は開発コンテナと p3 のコンテナでマウントして共有することがあり、そこに置くと別の環境を同じとみなしてしまう）
 *   - boot: OS の起動ごとの識別子（Linux の /proc/sys/kernel/random/boot_id）
 *   - pidNs: PID の名前空間（Linux の /proc/self/ns/pid）。コンテナ・サンドボックスの中は別の名前空間
 *   - pid と start: プロセスの番号と、起動の時刻（Linux の /proc/<pid>/stat の starttime。番号の使い回しを見分ける）
 *
 * 判定（確かめられないときは死んだとしない）:
 *   - alive: 同じ環境・同じ起動・同じ名前空間で、同じ番号・同じ起動の時刻のプロセスがある
 *   - dead: 同じ環境で、OS が起動し直した／その番号のプロセスが無い／番号は同じでも起動の時刻が違う（使い回し）
 *   - unknown: 記録が無い（以前の run）・別の環境（別のマシン、作り直したコンテナ）・別の名前空間（コンテナを起動し直した、
 *     サンドボックス）・Linux 以外で起動の時刻を確かめられない・記録を作れなかった
 */

export type OwnerState = { state: "alive" } | { state: "dead"; reason: string } | { state: "unknown"; reason: string };

/** 判定に使うこのマシンの読み取り（テストが差し替える） */
export interface OwnerProbe {
  /** このプロセスの記録（作れなければ undefined） */
  self(): RunOwner | undefined;
  /** そのプロセスの起動の時刻。プロセスが無ければ null、確かめられなければ undefined */
  startOf(pid: number): string | null | undefined;
}

let cached: RunOwner | null | undefined;

/** このプロセスの所有者の記録（一度だけ作る。作れなければ undefined） */
export function currentOwner(): RunOwner | undefined {
  if (cached === undefined) cached = makeOwner() ?? null;
  return cached ?? undefined;
}

function makeOwner(): RunOwner | undefined {
  const id = instanceId();
  if (!id) return undefined;
  const linux = process.platform === "linux";
  const start = linux ? procStart(process.pid) : undefined;
  return {
    instance: createHash("sha256").update(`${id}\n${hostname()}`).digest("hex").slice(0, 24),
    ...(linux ? { boot: readTrim("/proc/sys/kernel/random/boot_id"), pidNs: readNs() } : {}),
    pid: process.pid,
    ...(start ? { start } : {}),
  };
}

/** ローカルの状態のフォルダの識別子（無ければ作る）。読めない・書けなければ undefined */
function instanceId(): string | undefined {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const file = join(base, "infodb-p3", "instance-id");
  try {
    const v = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(v)) return v;
  } catch {
    // 無ければ作る
  }
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const v = randomBytes(16).toString("hex");
    // 同時に作ったときは先に書いたほうを使う（wx）
    try {
      writeFileSync(file, `${v}\n`, { flag: "wx", mode: 0o600 });
      return v;
    } catch {
      const again = readFileSync(file, "utf8").trim();
      return /^[0-9a-f]{32}$/.test(again) ? again : undefined;
    }
  } catch {
    return undefined;
  }
}

function readTrim(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function readNs(): string | undefined {
  try {
    return readlinkSync("/proc/self/ns/pid").replace(/^pid:\[(\d+)\]$/, "$1");
  } catch {
    return undefined;
  }
}

/** Linux の /proc/<pid>/stat の starttime（22 番目。名前に空白や括弧を含んでもよいように、最後の ")" の後ろで数える） */
function procStart(pid: number): string | null | undefined {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return fields[19] || undefined;
}

/** 既定の読み取り: Linux は /proc、ほかはプロセスがあるかだけ（起動の時刻は確かめられない） */
export const systemProbe: OwnerProbe = {
  self: currentOwner,
  startOf(pid) {
    if (process.platform === "linux") return procStart(pid);
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH" ? null : undefined;
    }
  },
};

/** 記録したプロセスが今も動いているか（確かめられなければ unknown。死んだと推測しない） */
export function ownerState(owner: RunOwner | undefined, probe: OwnerProbe = systemProbe): OwnerState {
  if (!owner) return { state: "unknown", reason: "実行したプロセスの記録がありません（以前の版で始めた run）" };
  const me = probe.self();
  if (!me) return { state: "unknown", reason: "このマシンの識別子を作れないので確かめられません" };
  if (owner.instance !== me.instance) return { state: "unknown", reason: "別の環境（別のマシンかコンテナ）で始めた run です" };
  if (owner.boot && me.boot && owner.boot !== me.boot) return { state: "dead", reason: "始めた後に OS が起動し直しています" };
  if ((owner.pidNs ?? "") !== (me.pidNs ?? "")) return { state: "unknown", reason: "別のプロセスの名前空間（コンテナの起動し直し・サンドボックスなど）で始めた run です" };
  const start = probe.startOf(owner.pid);
  if (start === null) return { state: "dead", reason: `実行していたプロセス（${owner.pid}）が終わっています` };
  if (start === undefined || !owner.start) return { state: "unknown", reason: "実行していたプロセスが同じものか確かめられません" };
  if (start !== owner.start) return { state: "dead", reason: `実行していたプロセス（${owner.pid}）は終わり、同じ番号の別のプロセスがあります` };
  return { state: "alive" };
}
