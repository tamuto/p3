import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Hierarchy, type HierarchyIssue } from "../shared/hierarchy.ts";
import { REQUEST_ID } from "../shared/refs.ts";
import type { Request } from "../shared/types.ts";
import { withFileLock } from "./store/fsutil.ts";
import type { Workspace } from "./store/workspace.ts";

/**
 * 要望の親子の規則（docs/architecture.md の「大きい要望の分割」）。CLI と API は requestOps.ts を通してここを使う。
 *   - 親にできるのは、形の正しい、今ある（アーカイブしていない・読める）、自分でも自分の子孫でもない要望だけ
 *   - 付け替え・外す・子の作成・アーカイブは、プロジェクトの中の関係の操作のロック（requests/.hierarchy.lock）の中で、
 *     要望をディスクから読み直してから確かめる（2つのプロセスが同時に逆向きに付け替えても循環にならない）
 *   - ロックを使わない直接編集は防げない。読み込みで親子の問題（Hierarchy.issues）として知らせる
 */

export type HierarchyErrorCode = "hierarchy_invalid" | "hierarchy_busy" | "has_children" | "has_parent" | "child_order_invalid";
export type HierarchyInvalidReason = "not_found" | "self" | "cycle" | "archived" | "invalid_id" | "unreadable";
/**
 * 子の表示順の保存を断る理由（child_order_invalid）。duplicate: 同じ ID が2回 / not_child: 今は直下の子でない（ほかの親の子・親の無い
 * 要望）/ not_found: 要望が無い / missing: 直下の子が足りない / no_children: 子が無い。not_child・missing は読んだ後に子の集合が
 * 変わったときにも起きる（読み直してやり直す）
 */
export type ChildOrderInvalidReason = "duplicate" | "not_child" | "not_found" | "missing" | "no_children";

/** 親子の規則に合わない・ロックを取れない（何も書いていない） */
export class HierarchyError extends Error {
  constructor(
    readonly code: HierarchyErrorCode,
    message: string,
    readonly detail: { reason?: HierarchyInvalidReason | ChildOrderInvalidReason; ids?: string[]; children?: string[] } = {},
  ) {
    super(message);
  }
}

/** ロックを待つ時間（越えたら hierarchy_busy。何も書いていないので、そのままやり直せる） */
const LOCK_TIMEOUT_MS = 10_000;
const BUSY = "p3:hierarchy-busy";

/** アーカイブした要望の ID（requests/.archive/ のフォルダ名） */
export async function archivedRequestIds(ws: Workspace): Promise<string[]> {
  return (await readdir(join(ws.requestsDir, ".archive"), { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && REQUEST_ID.test(d.name))
    .map((d) => d.name);
}

/** 今読み込んでいる要望から親子を作る（アーカイブ済みはディスクから読む） */
export async function hierarchyOf(ws: Workspace): Promise<Hierarchy> {
  return new Hierarchy({ requests: ws.requests.list(), unreadable: ws.requests.errors.keys(), archived: await archivedRequestIds(ws) });
}

/** 関係の操作を1つずつにする。取れなければ hierarchy_busy */
export async function withHierarchyLock<T>(ws: Workspace, fn: () => Promise<T>): Promise<T> {
  try {
    return await withFileLock(join(ws.requestsDir, ".hierarchy.lock"), fn, { timeoutMs: LOCK_TIMEOUT_MS, busyMessage: BUSY });
  } catch (e) {
    if ((e as Error).message === BUSY) {
      throw new HierarchyError("hierarchy_busy", "ほかの操作が要望の親子を変えています（何も変えていません。もう一度やり直してください）");
    }
    throw e;
  }
}

/** ロックの中で: 要望の一覧をディスクから読み直す（ほかのプロセスが変えた親を取り込む） */
async function fresh(ws: Workspace): Promise<Hierarchy> {
  await ws.requests.load();
  return hierarchyOf(ws);
}

/**
 * child（作るときは undefined）の親を parent にしてよいかを確かめる。ロックの中で呼ぶ。
 * 合わなければ HierarchyError（hierarchy_invalid）
 */
async function checkParent(ws: Workspace, h: Hierarchy, child: string | undefined, parent: string): Promise<Request> {
  const invalid = (reason: HierarchyInvalidReason, message: string) => new HierarchyError("hierarchy_invalid", message, { reason });
  if (!REQUEST_ID.test(parent)) throw invalid("invalid_id", `親の ID の形が違います: ${parent}（例: 261009-k7m3x。ほかのプロジェクトの要望は親にできません）`);
  if (child === parent) throw invalid("self", `${parent} は自分自身を親にできません`);
  if (ws.requests.errors.has(parent)) throw invalid("unreadable", `親 ${parent} のファイルが読めません（直してから指定してください）`);
  const p = h.get(parent);
  if (!p) {
    if ((await archivedRequestIds(ws)).includes(parent)) throw invalid("archived", `親 ${parent} はアーカイブ済みです`);
    throw invalid("not_found", `親の要望がありません: ${parent}`);
  }
  if (child && h.ancestors(parent).some((a) => a.id === child)) {
    throw invalid("cycle", `${parent} は ${child} の子孫なので親にできません（循環します）`);
  }
  // 親の側が既に循環しているなら、その下に付けない
  const broken = h.issueOf(p);
  if (broken?.code === "parent_cycle") throw invalid("cycle", `親 ${parent} の祖先が循環しています（${broken.message}）`);
  return p;
}

/**
 * 子を作る前に: ロックの中で親を確かめ、作成の入力に親の管理情報（期限・マイルストーン・タグ）を写して fn に渡す。
 * 写すのは入力で指定していない項目だけ（タグは空なら写す）。作った後は親と子で別々に変えてよい
 */
export async function withNewChild<T>(
  ws: Workspace,
  parent: string,
  input: Partial<Request>,
  fn: (input: Partial<Request>) => Promise<T>,
): Promise<T> {
  return withHierarchyLock(ws, async () => {
    const p = await checkParent(ws, await fresh(ws), undefined, parent);
    return fn(inheritFrom(p, input));
  });
}

/** 子の作成の入力に、指定していない期限・マイルストーン・タグを親から写す（作るときだけ） */
export function inheritFrom(p: Request, input: Partial<Request>): Partial<Request> {
  return {
    ...input,
    parent: p.id,
    due: input.due ?? p.due,
    milestone: input.milestone ?? p.milestone,
    tags: input.tags?.length ? input.tags : [...p.tags],
  };
}

/** 親を付け替える・外す（parent が undefined）前に: ロックの中で確かめてから fn（保存）を呼ぶ。前の親を返す */
export async function withParentChange<T>(ws: Workspace, rid: string, parent: string | undefined, fn: () => Promise<T>): Promise<{ result: T; previous?: string }> {
  return withHierarchyLock(ws, async () => {
    const h = await fresh(ws);
    const cur = ws.requests.require(rid);
    if (parent !== undefined) await checkParent(ws, h, rid, parent);
    return { result: await fn(), previous: cur.parent };
  });
}

/**
 * 子の表示順を保存する前に: ロックの中で要望を読み直し、ids が今の直下の子の完全な並び（重複・過不足なし）かを確かめてから
 * fn（親の保存。rev の楽観ロックは fn の側）を呼ぶ。合わなければ HierarchyError（child_order_invalid。detail.children に今の子の並び）
 */
export async function withChildOrder<T>(ws: Workspace, parent: string, ids: readonly string[], fn: () => Promise<T>): Promise<T> {
  return withHierarchyLock(ws, async () => {
    const h = await fresh(ws);
    ws.requests.require(parent);
    const now = h.children(parent).map((c) => c.id);
    const invalid = (reason: ChildOrderInvalidReason, message: string, bad: string[] = []) =>
      new HierarchyError("child_order_invalid", `${message}（何も変えていません）`, { reason, ids: bad, children: now });
    if (!now.length) throw invalid("no_children", `${parent} には子の要望がありません`);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) throw invalid("duplicate", `同じ子が2回あります: ${[...new Set(dup)].join(", ")}`, [...new Set(dup)]);
    const unknown = ids.filter((id) => !h.get(id));
    if (unknown.length) throw invalid("not_found", `要望がありません: ${unknown.join(", ")}`, unknown);
    const others = ids.filter((id) => !now.includes(id));
    if (others.length) {
      const where = others.map((id) => `${id}（${h.get(id)!.parent ? `${h.get(id)!.parent} の子` : "親なし"}）`).join(", ");
      throw invalid("not_child", `${parent} の直下の子ではありません: ${where}。子が変わっていれば読み直してやり直してください`, others);
    }
    const missing = now.filter((id) => !ids.includes(id));
    if (missing.length) {
      throw invalid("missing", `直下の子を全部並べてください。足りない子: ${missing.join(", ")}（子が増えていれば読み直してやり直してください）`, missing);
    }
    return fn();
  });
}

/** アーカイブの前に: 子のある要望・親のある要望は断る（未完了の子を暗黙に外さない）。ロックの中で fn を呼ぶ */
export async function withArchiveCheck<T>(ws: Workspace, rid: string, fn: () => Promise<T>): Promise<T> {
  return withHierarchyLock(ws, async () => {
    const h = await fresh(ws);
    const r = ws.requests.require(rid);
    const kids = h.children(rid).map((c) => c.id);
    if (kids.length) {
      throw new HierarchyError("has_children", `${rid} には子の要望があります: ${kids.join(", ")}（子の親を外す（p3 request set <子> parent=）か、子を先に片付けてからアーカイブしてください）`, { ids: kids });
    }
    if (r.parent) {
      throw new HierarchyError("has_parent", `${rid} は ${r.parent} の子です（p3 request set ${rid} parent= で親を外してからアーカイブしてください）`, { ids: [r.parent] });
    }
    return fn();
  });
}

/**
 * 分割の採用（run.json の adoption）で作った子のうち、今の要望にもアーカイブにも無いもの。ファイルは変えず、parent も戻さない。
 * 子のフォルダが要望のブランチにだけあって、既定のブランチに切り替えると作業ツリーから消えたときなど
 */
async function missingSplitChildren(ws: Workspace, rid: string, archived: Set<string>): Promise<HierarchyIssue[]> {
  const out: HierarchyIssue[] = [];
  for (const run of await ws.preflight.list(rid)) {
    const a = run.adoption;
    if (!a) continue;
    for (const key of a.created) {
      const id = a.reserved[key];
      if (!id || ws.requests.get(id) || ws.requests.errors.has(id) || archived.has(id)) continue;
      out.push({ request: id, code: "child_missing", parent: rid, message: `分割で作った子 ${id}（${run.id} / ${key}）が見つかりません（git のブランチを切り替えると、要望のブランチにだけある要望は作業ツリーから消えます）` });
    }
  }
  return out;
}

/** 詳細・show --brief に添える親子（子にはタスクの数を付ける） */
export async function hierarchyView(ws: Workspace, rid: string) {
  const v = (await hierarchyOf(ws)).view(rid);
  return {
    ...v,
    hierarchyIssues: [...v.hierarchyIssues, ...(await missingSplitChildren(ws, rid, new Set(await archivedRequestIds(ws))))],
    children: v.children.map((c) => {
      const tasks = ws.tasksOf(c.id).list();
      return { ...c, tasks: { total: tasks.length, done: tasks.filter((t) => t.status === "done").length } };
    }),
  };
}
