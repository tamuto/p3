import { execFile } from "node:child_process";
import type { RefCapture } from "../shared/completionRecord.ts";
import type { ResolvedRef } from "./repoRefs.ts";

/**
 * 完了の記録に残す参照先の取得（shared/completionRecord.ts の RefCapture）。登録された参照先ごとに、このマシンのパスで
 * HEAD のコミットと未コミットの変更の有無を取る。取れなければ理由を残す（推測で埋めない）。このマシンのパスは残さない。
 * 書く前（ロックの外）に取るので、取得時刻を参照先ごとに残す
 */

const UNAVAILABLE: Record<"unregistered" | "missing" | "notdir", string> = {
  unregistered: "このマシンのパスが登録されていません",
  missing: "登録したパスがありません",
  notdir: "登録したパスがフォルダではありません",
};

function git(local: string, args: string[]): Promise<{ ok: true; out: string } | { ok: false; err: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", local, ...args], { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve(err ? { ok: false, err: `${stderr || err.message}` } : { ok: true, out: stdout }),
    );
  });
}

/** git の失敗の理由（このマシンのパスを伏せて1行に） */
const reasonOf = (err: string, local: string) => (err.split("\n").find((l) => l.trim()) ?? "git の実行に失敗しました").split(local).join("<参照先>").trim().slice(0, 300);

export async function captureRef(r: ResolvedRef, now: () => string = () => new Date().toISOString()): Promise<RefCapture> {
  if (r.status !== "ok" || !r.local) {
    const state = r.status === "ok" ? "unregistered" : r.status;
    return { name: r.name, state, at: now(), reason: UNAVAILABLE[state] };
  }
  const local = r.local;
  const inside = await git(local, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) {
    if (/not a git repository/i.test(inside.err)) return { name: r.name, state: "not_git", at: now(), reason: "git のリポジトリではありません" };
    return { name: r.name, state: "failed", at: now(), reason: reasonOf(inside.err, local) };
  }
  const head = await git(local, ["rev-parse", "HEAD"]);
  if (!head.ok) return { name: r.name, state: "failed", at: now(), reason: /unknown revision|ambiguous argument/i.test(head.err) ? "コミットがありません" : reasonOf(head.err, local) };
  const status = await git(local, ["status", "--porcelain", "--", "."]);
  return {
    name: r.name,
    state: "ok",
    commit: head.out.trim(),
    ...(status.ok ? { dirty: status.out.trim() !== "" } : { reason: `未コミットの変更を確かめられません: ${reasonOf(status.err, local)}` }),
    at: now(),
  };
}

/** 登録された参照先を全部取る（並べて実行） */
export function captureRefs(refs: readonly ResolvedRef[]): Promise<RefCapture[]> {
  return Promise.all(refs.map((r) => captureRef(r)));
}
