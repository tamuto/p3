import { Hierarchy } from "../shared/hierarchy.ts";
import type { Request, RequestStatus } from "../shared/types.ts";
import type { Workspace } from "./store/workspace.ts";

/**
 * 要望の「対応済」（resolved）の規則。CLI と API のどちらから変えても同じように効くよう、ここにまとめる。
 *
 *   - 対応済にできるのは、自分のタスクが全部完了（status=done）で読めないタスクファイルが無く、見送り以外の子が全部
 *     対応済か完了済（その配下も同じ。外で編集された子の未完了も見つける）で、配下に親子の問題が無く、自分のタスクか
 *     見送り以外の子が1件以上あるときだけ。見送りの子は対象外（excluded）。人の「済み」（checkedAt）・PR・マージは条件にしない。
 *     置き換えられたタスクも、残っていれば数える
 *   - 子のある要望を完了済（done）にするときも同じ条件を確かめる（子の無い要望の完了済は今までどおり確かめない）
 *   - 対応済の要望に未完了のタスクができたら（足した・完了から戻した・再評価でタスク化した）進行中に戻す。配下に未完了が
 *     できたら、対応済の祖先も進行中に戻し、完了済の祖先は変えずに警告（ancestor_done）を返す
 *   - 最後のタスクを完了にしても自動では対応済・完了済にしない（作業を終えた側・人が明示的に設定する）
 */

export class StatusRuleError extends Error {}

/** 完了済の祖先の下に未完了ができた（祖先は変えていない。人に再開を促す） */
export interface AncestorWarning {
  code: "ancestor_done";
  /** 完了済の祖先 */
  target: string;
  /** 未完了になった要望 */
  from: string;
  message: string;
}

/** 判定の結果。blocker: できない理由（できるなら無い）/ excluded: 対象外にした見送りの子 */
export interface CompletionCheck {
  blocker?: string;
  excluded: string[];
}

const finished = (s: RequestStatus) => s === "resolved" || s === "done";

/** 読み込んである要望の親子（読めない要望も問題として扱う） */
export function hierarchyNow(ws: Workspace): Hierarchy {
  return new Hierarchy({ requests: ws.requests.list(), unreadable: ws.requests.errors.keys() });
}

/**
 * 読み込んである状態で判定する（書かない・読み直さない）。リリースノートの材料のように、読み直した Workspace の上で使う。
 * 子孫は見送りの子とその下を除いて辿る
 */
export function completionCheckOf(ws: Workspace, h: Hierarchy, rid: string): CompletionCheck {
  const col = ws.tasksOf(rid);
  const broken = [...col.errors.keys()];
  const kids = h.children(rid);
  const excluded = kids.filter((k) => k.status === "rejected").map((k) => k.id);
  const result = (blocker?: string): CompletionCheck => ({ ...(blocker ? { blocker } : {}), excluded });
  if (broken.length) return result(`読めないタスクファイルがあります: ${broken.join(", ")}（直してから対応済にしてください）`);
  const self = h.get(rid);
  const own = self ? h.issueOf(self) : undefined;
  if (own) return result(`親子の問題があります: ${own.message}`);
  const tasks = col.list();
  const live = kids.filter((k) => k.status !== "rejected");
  if (!tasks.length && !live.length) {
    return result(
      kids.length
        ? `タスクが無く、子の要望が全部見送りです（対象外: ${excluded.join(", ")}）。対応済にできません`
        : "タスクがありません（タスクの無い要望は対応済にできません）",
    );
  }
  const open = tasks.filter((t) => t.status !== "done");
  if (open.length) return result(`完了していないタスクがあります: ${open.map((t) => `${t.id}(${t.status})`).join(", ")}（完了させるか、不要ならアーカイブしてから対応済にしてください）`);
  // 配下: 見送り以外の子孫が全部 対応済・完了済で、その自分のタスクも全部完了
  const problems: string[] = [];
  const seen = new Set<string>([rid]);
  const walk = (pid: string) => {
    for (const c of h.children(pid)) {
      if (c.status === "rejected" || seen.has(c.id)) continue;
      seen.add(c.id);
      const issue = h.issueOf(c);
      const ccol = ws.tasksOf(c.id);
      const cbroken = [...ccol.errors.keys()];
      const copen = ccol.list().filter((t) => t.status !== "done");
      if (issue) problems.push(issue.message);
      else if (!finished(c.status)) problems.push(`子 ${c.id} が未完了（${c.status}）`);
      else if (cbroken.length) problems.push(`子 ${c.id} に読めないタスクファイル（${cbroken.join(", ")}）`);
      else if (copen.length) problems.push(`子 ${c.id} は ${c.status} ですが完了していないタスクがあります（${copen.map((t) => `${t.id}(${t.status})`).join(", ")}）`);
      walk(c.id);
    }
  };
  walk(rid);
  if (problems.length) return result(`配下の要望が終わっていません: ${problems.join(" / ")}`);
  return result();
}

/** 要望とその子孫を読み直す（判定の直前。外での変更を取り込む） */
async function refresh(ws: Workspace, rid: string): Promise<Hierarchy> {
  await ws.requests.load();
  const h = hierarchyNow(ws);
  await Promise.all([rid, ...h.descendants(rid).map((r) => r.id)].map((id) => ws.tasksOf(id).load()));
  return h;
}

/** 対応済にできるか（ディスクから読み直して判定する） */
export async function completionCheck(ws: Workspace, rid: string): Promise<CompletionCheck> {
  return completionCheckOf(ws, await refresh(ws, rid), rid);
}

/** 対応済にできないなら理由（できるなら undefined）。判定の直前にディスクから読み直す */
export async function resolveBlocker(ws: Workspace, rid: string): Promise<string | undefined> {
  return (await completionCheck(ws, rid)).blocker;
}

/** ステータスを対応済（子のある要望は完了済も）に変えるなら規則を確かめる（満たさなければ何も書かずに失敗する） */
export async function checkStatusChange(ws: Workspace, rid: string, next: RequestStatus | undefined): Promise<void> {
  if (next !== "resolved" && next !== "done") return;
  if (next === "done") {
    await ws.requests.load();
    if (!hierarchyNow(ws).children(rid).length) return;
  }
  const why = await resolveBlocker(ws, rid);
  if (why) throw new StatusRuleError(`${rid} を${next === "done" ? "完了済" : "対応済"}にできません: ${why}`);
}

/** 対応済・完了済なのに未完了のタスク・配下がある（外部の直接編集など）。画面と CLI で知らせる */
export function resolvedIssue(ws: Workspace, r: Request): string | undefined {
  if (!finished(r.status)) return undefined;
  const label = r.status === "resolved" ? "対応済" : "完了済";
  const open = ws.tasksOf(r.id).list().filter((t) => t.status !== "done");
  if (open.length && r.status === "resolved") return `対応済ですが、完了していないタスクがあります: ${open.map((t) => t.id).join(", ")}（進行中に戻すには status=active）`;
  const h = hierarchyNow(ws);
  if (!h.children(r.id).length) return undefined;
  const { blocker } = completionCheckOf(ws, h, r.id);
  return blocker ? `${label}ですが、${blocker}（進行中に戻すには status=active）` : undefined;
}

/**
 * タスクを変えた後に呼ぶ: 対応済の要望に未完了のタスクがあれば進行中に戻す。戻したら true。
 * タスクの変更は済んでいるので、要望の更新に失敗したら、そう分かるエラーにする（再試行は request set status=active）。
 */
export async function reopenIfNeeded(ws: Workspace, rid: string, actor?: string): Promise<boolean> {
  const r = ws.requests.get(rid);
  if (!r || r.status !== "resolved") return false;
  if (!ws.tasksOf(rid).list().some((t) => t.status !== "done")) return false;
  try {
    await ws.requests.update(rid, { status: "active" }, { actor });
    return true;
  } catch (e) {
    throw new Error(`タスクは更新しましたが、要望 ${rid} を進行中に戻せませんでした: ${(e as Error).message}（p3 request set ${rid} status=active で直してください）`);
  }
}

/** 祖先を戻した結果。reopened: 対応済から進行中に戻した祖先（近い順）/ warnings: 完了済のまま残した祖先 */
export interface AncestorReopen {
  reopened: string[];
  warnings: AncestorWarning[];
}

/**
 * 要望（rid）を変えた後に呼ぶ: rid が未完了（対応済・完了済でない、または自分のタスクに未完了がある）なら、対応済の祖先を
 * 近い順に進行中に戻し、完了済の祖先は警告にする。見送りの祖先より上は、rid を対象外にしているので辿らない。
 * 途中で失敗したら、戻したものと失敗したものと直し方が分かるエラーにする（戻したものは戻さない）
 */
export async function reopenAncestors(ws: Workspace, rid: string, actor?: string): Promise<AncestorReopen> {
  const out: AncestorReopen = { reopened: [], warnings: [] };
  const r = ws.requests.get(rid);
  if (!r || r.status === "rejected") return out;
  const open = !finished(r.status) || ws.tasksOf(rid).list().some((t) => t.status !== "done");
  if (!open) return out;
  for (const a of hierarchyNow(ws).ancestors(rid).reverse()) {
    if (a.status === "rejected") break;
    if (a.status === "done") {
      out.warnings.push({
        code: "ancestor_done",
        target: a.id,
        from: rid,
        message: `祖先の ${a.id} は完了済ですが、配下の ${rid} が未完了になりました（再開するなら p3 request set ${a.id} status=active）`,
      });
    } else if (a.status === "resolved") {
      try {
        await ws.requests.update(a.id, { status: "active" }, { actor });
        out.reopened.push(a.id);
      } catch (e) {
        const done = out.reopened.length ? `${out.reopened.join(", ")} は進行中に戻しましたが、` : "";
        throw new Error(`${done}祖先の ${a.id} を進行中に戻せませんでした: ${(e as Error).message}（p3 request set ${a.id} status=active で直してください）`);
      }
    }
  }
  return out;
}
