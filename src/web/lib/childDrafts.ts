import type { AdoptionResult, InputMatch, PreflightRun, ProposedChild } from "../../shared/types.ts";

/**
 * 子の要望の案（分割の run）の画面の規則。採用を止める理由・編集の下書き・結果の見せ方を、部品（ChildDrafts.tsx）から分けて確かめる。
 * 規則（採用・古さ・版）はサーバ（core/preflight/service.ts の adopt）が決め、画面は見せて頼むだけ
 */

/** 案の編集の下書き（保存するまで案のファイルは変えない）。base は編集を始めたときの題（他で変わったら競合） */
export interface ChildEdit {
  title: string;
  description: string;
  base: string;
}

export const editOf = (c: ProposedChild): ChildEdit => ({ title: c.title, description: c.description, base: c.title });

/** 下書きが案と違う（未保存） */
export const editDirty = (e: ChildEdit | undefined, c: ProposedChild) => !!e && (e.title !== c.title || e.description !== c.description);

/** 編集中に案の題が他で変わった（入力は残し、保存しない） */
export const editConflict = (e: ChildEdit | undefined, c: ProposedChild) => !!e && e.base !== c.title;

/**
 * 採用（確認を開く・作る）を止める理由。無ければ null。
 *   済んだ・古い評価・案の問題・未保存の入力（要望の本文・題、案の編集）・選んだ案が0件・実行中
 */
export function adoptBlocker(
  run: Pick<PreflightRun, "children" | "adoption" | "draftProblems"> & { inputMatch?: InputMatch },
  o: { edits: Record<string, ChildEdit>; busy: boolean; blocked: string | null; problems?: string[] },
): string | null {
  const children = run.children ?? [];
  if (run.adoption?.done) return "この評価から子の要望を作成済みです";
  if (run.inputMatch && run.inputMatch.status !== "same") return "この評価は今の要望（または親子）と違うので、採用できません。もう一度 Preflight を実行してください";
  const problems = o.problems ?? run.draftProblems ?? [];
  if (problems.length) return "子の案に問題があるので採用できません。案のファイルを直すか、もう一度 Preflight を実行してください";
  if (o.blocked) return o.blocked;
  if (children.some((c) => editDirty(o.edits[c.key], c))) return "保存していない子の案の編集があります。保存するか、取り消してから採用してください";
  // 採用を始めた run は選んだ案のまま続ける（選び直さない）
  if (!run.adoption && !children.some((c) => c.include)) return "採用する子の案を選んでください";
  if (o.busy) return "処理中です";
  return null;
}

/** 採用の結果の見出し（作った・失敗・未実行） */
export function adoptionSummary(r: AdoptionResult): string {
  if (!r.failed.length) return `子の要望を ${r.created.length} 件作成しました。親は残し、子の Preflight はまだ実行していません`;
  return `${r.created.length} 件を作成し、${r.failed.map((f) => f.key).join(", ")} で止まりました${r.pending.length ? `（未実行: ${r.pending.join(", ")}）` : ""}。作った子は残しています。原因を直して「続きを作る」を押すと、作った子は作り直さずに続けます`;
}
