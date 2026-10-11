import { absRef, parseRef } from "../shared/refs.ts";
import type { PreflightRun, SupersedeCandidate, SupersededMark } from "../shared/types.ts";
import type { Workspace } from "./store/workspace.ts";

/**
 * 置き換え（supersedes）の判定。どこで使っても同じ規則にするため、ここにまとめる。
 *
 * 印（一覧・詳細・ボード・着手の警告）: 保存済みの要望とタスクの relations にある直接の supersedes だけを見る。
 *   評価にだけある置き換えはタスク化で要望の関係として残るので、要望単位の置き換え（from = 要望 ID）として出す。
 *   特定の後継タスクへ推測して配らない。
 */
export function supersededMarks(ws: Workspace): Map<string, SupersededMark[]> {
  const marks = new Map<string, SupersededMark[]>();
  const add = (from: string, base: string, target: string, note?: string) => {
    const ref = absRef(target, base);
    // 今あるタスクだけ（アーカイブしたタスクには印を付けない）
    if (!ref || !parseRef(ref)?.task || ref === from || !ws.task(ref)) return;
    const list = marks.get(ref) ?? [];
    if (!list.some((m) => m.from === from)) list.push({ from, note });
    marks.set(ref, list);
  };
  for (const r of ws.requests.list()) {
    for (const rel of r.relations) if (rel.type === "supersedes") add(r.id, r.id, rel.target, rel.note);
    for (const t of ws.tasksOf(r.id).list()) {
      for (const rel of t.relations) if (rel.type === "supersedes") add(t.ref, r.id, rel.target, rel.note);
    }
  }
  return marks;
}

/**
 * タスク化で知らせる置き換えられるタスク: 評価の impacts と採用したタスク案の relations にある supersedes のうち、
 * 同じ要望にある未完了（todo / doing）のタスク。不採用の案だけにある関係・完了したタスク・無いタスク・
 * 別の要望・要望そのものは含めない。
 */
export function supersedeCandidates(ws: Workspace, run: PreflightRun): SupersedeCandidate[] {
  const rid = run.requestId;
  const found = new Map<string, SupersedeCandidate>();
  const add = (target: string, reason: SupersedeCandidate["reasons"][number]) => {
    const ref = absRef(target, rid);
    const p = ref ? parseRef(ref) : undefined;
    if (!ref || !p?.task || p.request !== rid) return;
    const t = ws.task(ref);
    if (!t || t.status === "done") return;
    const c = found.get(ref) ?? { id: t.id, ref, title: t.title, status: t.status, rev: t.rev, reasons: [] };
    c.reasons.push(reason);
    found.set(ref, c);
  };
  for (const i of run.assessment?.impacts ?? []) if (i.type === "supersedes") add(i.target, { source: "impact", note: i.reason });
  for (const d of run.drafts) {
    if (!d.include) continue;
    for (const r of d.relations) if (r.type === "supersedes") add(r.target, { source: "draft", draft: d.key, note: r.note });
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** 操作は続けたうえで知らせる注意（CLI は stderr と --json の warnings、API は warnings） */
export interface Warning {
  code: "superseded";
  /** 対象のタスク（<要望ID>/T001） */
  target: string;
  /** 置き換えた側 */
  from: string[];
  message: string;
}

/**
 * 置き換えられたタスクに着手したときの警告。状態が作業中に変わったときだけ出す（作業中のままの再指定では出さない）。
 * 着手は止めない（置き換えが誤りのこともあるので、判断は人と AI に任せる）。
 */
export function startWarnings(ws: Workspace, ref: string, prevStatus: string, nextStatus: string | undefined): Warning[] {
  if (nextStatus !== "doing" || prevStatus === "doing") return [];
  return supersededWarnings(supersededMarks(ws).get(ref) ?? [], ref);
}

/** 置き換えの印から作る注意。着手のとき（startWarnings）と詳細を読むとき（show の warnings）で同じ形にする */
export function supersededWarnings(marks: SupersededMark[], ref: string): Warning[] {
  if (!marks.length) return [];
  const from = marks.map((m) => m.from);
  const by = from.map((f) => (f.includes("/") ? f : `要望 ${f} の再評価`)).join(", ");
  return [{ code: "superseded", target: ref, from, message: `${ref} は ${by} で置き換えられています。置き換え先を確かめてから進めてください` }];
}
