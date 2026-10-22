import { REQUEST_ID } from "./refs.ts";
import type { Request, RequestStatus } from "./types.ts";

/**
 * 要望の親子（docs/architecture.md の「大きい要望の分割」）。子は request.md の parent で親を1つだけ指し、子の一覧は逆引きで作る。
 * ここは読んだ要望の一覧から導く判定だけ（I/O は core/hierarchy.ts）。直接編集で循環しても、訪れた ID を覚えて止まる。
 */

/** 分割を検討する目安の想定タスク数（Preflight の評価で、これ以上なら分割する・しないの説明を必須にする） */
export const SPLIT_HINT_TASKS = 6;

/**
 * 直接編集などでできた親子の問題。読み込みでは止めずに一覧・詳細・進捗に出し、完了の判定では通さない。
 *   parent_missing: 親が無い / parent_archived: 親がアーカイブ済み / parent_cycle: 親を辿ると自分に戻る /
 *   parent_invalid: 親の ID の形が違う / parent_unreadable: 親のファイルが読めない
 */
export type HierarchyIssueCode = "parent_missing" | "parent_archived" | "parent_cycle" | "parent_invalid" | "parent_unreadable";

export interface HierarchyIssue {
  /** 問題のある要望（parent を書いている側） */
  request: string;
  code: HierarchyIssueCode;
  parent: string;
  message: string;
}

/** 祖先・子の要約 */
export interface RequestLink {
  id: string;
  title: string;
  status: RequestStatus;
}

/** 親子を読むのに要るもの（要望の一覧と、読めない・アーカイブした要望の ID） */
export interface HierarchySource {
  requests: Request[];
  /** 読めない要望の ID */
  unreadable?: Iterable<string>;
  /** アーカイブした要望の ID */
  archived?: Iterable<string>;
}

const link = (r: Request): RequestLink => ({ id: r.id, title: r.title, status: r.status });

/** 作成日時の古い順 → ID（子の一覧の並び） */
export const byCreated = (a: Request, b: Request) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id, undefined, { numeric: true });

export class Hierarchy {
  private byId = new Map<string, Request>();
  private kids = new Map<string, Request[]>();
  private unreadable: Set<string>;
  private archived: Set<string>;

  constructor(src: HierarchySource) {
    for (const r of src.requests) this.byId.set(r.id, r);
    for (const r of src.requests) {
      if (!r.parent) continue;
      const list = this.kids.get(r.parent) ?? [];
      list.push(r);
      this.kids.set(r.parent, list);
    }
    for (const list of this.kids.values()) list.sort(byCreated);
    this.unreadable = new Set(src.unreadable ?? []);
    this.archived = new Set(src.archived ?? []);
  }

  get(id: string): Request | undefined {
    return this.byId.get(id);
  }

  /** 直下の子（作成日時の古い順 → ID） */
  children(id: string): Request[] {
    return this.kids.get(id) ?? [];
  }

  /** 子孫（深さ優先。循環しても1回ずつ。自分は含めない） */
  descendants(id: string): Request[] {
    const seen = new Set<string>([id]);
    const out: Request[] = [];
    const walk = (pid: string) => {
      for (const c of this.children(pid)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }

  /** 祖先（根から順）。辿れなくなったところ（無い・読めない・循環）で止める */
  ancestors(id: string): Request[] {
    const seen = new Set<string>([id]);
    const out: Request[] = [];
    let cur = this.byId.get(id)?.parent;
    while (cur && !seen.has(cur)) {
      const p = this.byId.get(cur);
      if (!p) break;
      seen.add(cur);
      out.unshift(p);
      cur = p.parent;
    }
    return out;
  }

  /** 1件の親の問題（無ければ undefined） */
  issueOf(r: Request): HierarchyIssue | undefined {
    const parent = r.parent;
    if (!parent) return undefined;
    const issue = (code: HierarchyIssueCode, message: string): HierarchyIssue => ({ request: r.id, code, parent, message });
    if (!REQUEST_ID.test(parent)) return issue("parent_invalid", `${r.id} の親の ID の形が違います: ${parent}`);
    if (parent === r.id) return issue("parent_cycle", `${r.id} の親が自分自身です`);
    if (this.unreadable.has(parent)) return issue("parent_unreadable", `${r.id} の親 ${parent} が読めません`);
    if (!this.byId.has(parent)) {
      return this.archived.has(parent)
        ? issue("parent_archived", `${r.id} の親 ${parent} はアーカイブ済みです`)
        : issue("parent_missing", `${r.id} の親 ${parent} がありません`);
    }
    // 親を辿って自分に戻れば循環
    const seen = new Set<string>();
    let cur: string | undefined = parent;
    while (cur && !seen.has(cur)) {
      if (cur === r.id) return issue("parent_cycle", `${r.id} の親を辿ると自分に戻ります（循環）`);
      seen.add(cur);
      cur = this.byId.get(cur)?.parent;
    }
    return undefined;
  }

  /** 全部の問題（要望の ID 順） */
  issues(): HierarchyIssue[] {
    return [...this.byId.values()]
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .flatMap((r) => this.issueOf(r) ?? []);
  }

  /** 要望とその祖先・子孫の問題（その要望の判定に関わるもの） */
  issuesAround(id: string): HierarchyIssue[] {
    const ids = [id, ...this.ancestors(id).map((r) => r.id), ...this.descendants(id).map((r) => r.id)];
    return ids.flatMap((x) => {
      const r = this.byId.get(x);
      return r ? (this.issueOf(r) ?? []) : [];
    });
  }

  /** 詳細・show --brief に添える親子 */
  view(id: string): { parent: string | null; ancestors: RequestLink[]; children: RequestLink[]; hierarchyIssues: HierarchyIssue[] } {
    return {
      parent: this.byId.get(id)?.parent ?? null,
      ancestors: this.ancestors(id).map(link),
      children: this.children(id).map(link),
      hierarchyIssues: this.issuesAround(id),
    };
  }
}
