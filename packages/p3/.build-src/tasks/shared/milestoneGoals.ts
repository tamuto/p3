import type { Milestone, MilestoneGoal } from "./types.ts";

/**
 * マイルストーンの目的（purpose）と予定している機能・目標（goals）の規則。CLI・API・画面で同じものを使う（保存は
 * core/store/workspace.ts の saveProject がこれで確かめる）。
 *
 *   - 目的は複数行の自由文。空は「目的なし」（project.yaml に書かない）
 *   - 予定機能は { id, text } の並び。id は追加のときに振り（G1, G2, ...。今ある最大の番号の次）、並べ替え・文言の変更で振り直さない
 *   - 目的だけ・予定機能だけでも保存できる。どちらも任意
 */
export const MILESTONE_GOAL_LIMITS = {
  /** 目的の文字数 */
  purpose: 4000,
  /** 予定機能の件数 */
  goals: 50,
  /** 予定機能1件の文字数 */
  goalText: 500,
} as const;

/** 予定機能の id（手で書いた project.yaml も読めるよう、G<番号> 以外の英数字も受け付ける） */
export const GOAL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;

/** 目的・予定機能の問題（保存を断る理由。無ければ空） */
export function milestoneGoalProblems(m: Pick<Milestone, "id" | "purpose" | "goals">): string[] {
  const out: string[] = [];
  const at = `マイルストーン ${m.id}`;
  if (m.purpose !== undefined && m.purpose.length > MILESTONE_GOAL_LIMITS.purpose) {
    out.push(`${at} の目的は ${MILESTONE_GOAL_LIMITS.purpose} 文字までです（${m.purpose.length} 文字）`);
  }
  const goals = m.goals ?? [];
  if (goals.length > MILESTONE_GOAL_LIMITS.goals) out.push(`${at} の予定機能は ${MILESTONE_GOAL_LIMITS.goals} 件までです（${goals.length} 件）`);
  const seen = new Set<string>();
  for (const [i, g] of goals.entries()) {
    const label = `${at} の予定機能 ${i + 1} 件目${g.id ? `（${g.id}）` : ""}`;
    if (!GOAL_ID_RE.test(g.id)) out.push(`${label} の id が使えません（英数字と . _ -、32 文字まで）`);
    else if (seen.has(g.id)) out.push(`${at} の予定機能の id が重複しています: ${g.id}`);
    seen.add(g.id);
    if (!g.text.trim()) out.push(`${label} が空です`);
    else if (g.text.length > MILESTONE_GOAL_LIMITS.goalText) out.push(`${label} は ${MILESTONE_GOAL_LIMITS.goalText} 文字までです（${g.text.length} 文字）`);
  }
  return out;
}

/** 次に足す予定機能の id（G<今ある最大の番号 + 1>。消した番号も、残っている最大より小さければ使わない） */
export function nextGoalId(goals: readonly MilestoneGoal[]): string {
  const max = goals.reduce((n, g) => Math.max(n, /^G(\d+)$/.exec(g.id) ? Number(g.id.slice(1)) : 0), 0);
  return `G${max + 1}`;
}

/**
 * 保存する形にそろえる: 目的は末尾の空白を落とし、空なら無し。予定機能は前後の空白を落とし、0 件なら無し。
 * 空の項目は消さない（問題として断る）
 */
export function tidyMilestoneGoals<T extends Milestone>(m: T): T {
  const purpose = m.purpose?.replace(/\s+$/, "");
  const goals = m.goals?.map((g) => ({ id: g.id.trim(), text: g.text.trim() }));
  return { ...m, purpose: purpose ? purpose : undefined, goals: goals?.length ? goals : undefined };
}
