import { createHash } from "node:crypto";
import type { ReleaseMaterial, ReleaseRequestItem, ReleaseSource, ReleaseWarning, Request, Task } from "../../shared/types.ts";
import type { Hierarchy } from "../../shared/hierarchy.ts";
import { completionCheckOf, hierarchyNow } from "../requestStatus.ts";
import { Workspace } from "../store/workspace.ts";

/**
 * マイルストーンのリリースノートの材料を取り出す。規則はここだけに置く（CLI・API・画面は結果を見せるだけ）。
 *
 *   - マイルストーンに属する要望を全部返す（アーカイブしたものは含まない）。並びは作成日時 → ID
 *   - 収録するのは、要望が対応済（resolved）か完了済（done）で、タスクが1件以上あり、全部が完了で、読めないタスクが無いもの。
 *     完了済でもタスクの実態を確かめる（直接編集で状態が食い違うことがある）
 *   - 見送り（rejected）は理由を付けて対象外。それ以外の状態は未完了として警告して対象外
 *   - 要約の材料は、収録する要望の、変更の記録（record）のある完了したタスクだけ。記録の無いものは警告し、
 *     要望の本文やタイトルで補わない
 *   - 読めない要望は所属が分からないので全体の警告に残す
 *   - 子のある要望は、配下（見送り以外の子孫。マイルストーンの外のものも）が全部 対応済・完了済で、そのタスクも全部完了のときだけ
 *     収録する（requestStatus.ts と同じ判定）。自分のタスクが無く子だけを持つ要望は構造の要望として判定に入れ、材料は持たない。
 *     材料は各要望の自分の変更の記録だけ（親に子の記録を写さない。子が別のマイルストーンなら、子の記録は子のマイルストーンにだけ入る）
 *
 * 抽出のたびにディスクから読み直した別の Workspace を使い、その時点の状態を固定して返す（画面・CLI のキャッシュに左右されない）。
 */
export async function extractMaterial(dataDir: string, milestone: string): Promise<ReleaseMaterial> {
  const snap = new Workspace(dataDir);
  await snap.load();
  return materialOf(snap, milestone);
}

const byId = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function materialOf(ws: Workspace, mid: string): ReleaseMaterial {
  const m = ws.project.milestones.find((x) => x.id === mid);
  const warnings: ReleaseWarning[] = [];
  if (!m) warnings.push({ code: "unknown_milestone", target: mid, message: `マイルストーン ${mid} は project.yaml にありません（直接編集で消えた可能性があります）` });
  for (const [id, e] of ws.requests.errors) {
    warnings.push({ code: "broken_request", target: `requests/${id}/request.md`, message: `要望のファイルを読めないため、このマイルストーンに属するか分かりません: ${e}` });
  }

  const members = ws.requests
    .list()
    .filter((r) => r.milestone === mid)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || byId(a.id, b.id));
  const h = hierarchyNow(ws);
  const requests: ReleaseRequestItem[] = [];
  const sources: ReleaseSource[] = [];
  /** 完了を左右する配下の状態（hash に入れる。表示したあとでマイルストーンの外の子が変わっても見つける） */
  const below: unknown[] = [];
  for (const r of members) {
    const col = ws.tasksOf(r.id);
    const item = classify(r, col.list(), [...col.errors.keys()], ws, h);
    requests.push(item.view);
    if (item.source) sources.push(item.source);
    const sub = h.descendants(r.id);
    if (sub.length) {
      below.push([r.id, sub.map((d) => [d.id, d.parent, d.status, [...ws.tasksOf(d.id).errors.keys()], ws.tasksOf(d.id).list().map((t) => [t.id, t.status])])]);
    }
  }

  const included = requests.filter((r) => r.included);
  if (!included.length) warnings.push({ code: "no_candidates", target: mid, message: "収録する要望がありません（対応済か完了済で、全タスクが完了した要望が無い）" });
  else if (!sources.some((s) => s.tasks.length)) warnings.push({ code: "no_sources", target: mid, message: "要約の材料（変更の記録のある完了したタスク）がありません。生成はできず、本文は手で書きます" });

  const material = {
    milestone: { id: mid, title: m?.title ?? mid, due: m?.due, done: m?.done, known: !!m },
    requests,
    sources,
    warnings,
  };
  return { ...material, hash: materialHash(material, below, h.issues()), extractedAt: new Date().toISOString() };
}

function classify(r: Request, all: Task[], broken: string[], ws: Workspace, h: Hierarchy): { view: ReleaseRequestItem; source?: ReleaseSource } {
  const kids = h.children(r.id);
  const tasks = [...all].sort((a, b) => byId(a.id, b.id));
  const warnings: ReleaseWarning[] = [];
  const view: ReleaseRequestItem = {
    id: r.id,
    title: r.title,
    status: r.status,
    createdAt: r.createdAt,
    included: false,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, hasRecord: !!t.record?.trim() })),
    warnings,
    ...(kids.length ? { children: kids.map((k) => k.id) } : {}),
  };
  const exclude = (reason: string, warn?: ReleaseWarning) => {
    view.reason = reason;
    if (warn) warnings.push(warn);
    return { view };
  };
  if (r.status === "rejected") return exclude("見送り");
  if (r.status !== "resolved" && r.status !== "done") {
    return exclude(`未完了（${r.status}）`, { code: "not_finished", target: r.id, message: `${r.id} はまだ終わっていません（${r.status}）。収録しません` });
  }
  if (broken.length) {
    return exclude("読めないタスクがある", { code: "broken_task", target: r.id, message: `${r.id} に読めないタスクのファイルがあります: ${broken.sort(byId).join(", ")}（直すまで収録しません）` });
  }
  const structural = !tasks.length && kids.some((k) => k.status !== "rejected");
  if (!tasks.length && !structural) return exclude("タスクが無い", { code: "no_tasks", target: r.id, message: `${r.id} にタスクがありません（収録しません）` });
  const open = tasks.filter((t) => t.status !== "done");
  if (open.length) {
    return exclude("完了していないタスクがある", {
      code: "open_tasks",
      target: r.id,
      message: `${r.id} は ${r.status} ですが、完了していないタスクがあります: ${open.map((t) => `${t.id}(${t.status})`).join(", ")}（収録しません）`,
    });
  }
  if (kids.length) {
    const { blocker } = completionCheckOf(ws, h, r.id);
    if (blocker) return exclude("配下の要望が終わっていない", { code: "open_children", target: r.id, message: `${r.id}: ${blocker}（収録しません）` });
  }
  view.included = true;
  if (structural) {
    // 構造の要望: 判定には入るが、自分の材料は無い（子の記録は子の側で収録する）
    view.structural = true;
    return { view };
  }
  const withRecord = tasks.filter((t) => t.record?.trim());
  for (const t of tasks) {
    if (!t.record?.trim()) warnings.push({ code: "missing_record", target: t.ref, message: `${t.ref} に変更の記録がありません（要約の材料にしません）` });
  }
  if (!withRecord.length) warnings.push({ code: "no_material", target: r.id, message: `${r.id} には変更の記録が1つもありません（要約に入りません）` });
  return {
    view,
    source: { request: r.id, title: r.title, status: r.status, tasks: withRecord.map((t) => ({ id: t.id, title: t.title, status: t.status, record: t.record!.trim() })) },
  };
}

/** 材料の識別子: 所属する要望の状態・タイトル・収録の可否と、要約の材料（記録まで）。抽出した日時と警告の文言は含めない */
function materialHash(m: Omit<ReleaseMaterial, "hash" | "extractedAt">, below: unknown[], issues: unknown[]): string {
  const key = {
    milestone: m.milestone.id,
    requests: m.requests.map((r) => ({ id: r.id, title: r.title, status: r.status, included: r.included, tasks: r.tasks.map((t) => [t.id, t.status, t.hasRecord]) })),
    sources: m.sources,
    broken: m.warnings.filter((w) => w.code === "broken_request").map((w) => w.target),
    // 親子が無ければ今までと同じ hash（保存済みのノートを「材料が変わった」にしない）
    ...(below.length ? { below } : {}),
    ...(issues.length ? { issues } : {}),
  };
  return createHash("sha256").update(JSON.stringify(key)).digest("hex");
}
