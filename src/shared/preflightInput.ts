import type { PreflightInput, PreflightRun } from "./types.ts";

/**
 * Preflight の評価対象（要望のタイトルと本文）の規則。サーバ（固定・比較・タスク化の判定）と画面（下書き）で同じものを使う。
 *
 * 正規化: 改行を LF にそろえ、前後の空白・空行を除く。要望のファイルは保存するときに本文の前後を除くので
 * （server/store/frontmatter.ts）、保存の形の違いだけで変わったことにしない。行末の空白（Markdown の改行）や途中の空行は残して比べる。
 */
export function normalizeText(s: string): string {
  return s.replace(/\r\n?/g, "\n").trim();
}

export function normalizeInput(r: { title: string; body: string }): PreflightInput {
  return { title: normalizeText(r.title), body: normalizeText(r.body) };
}

/** 保存すると同じになる本文か */
export const sameText = (a: string, b: string) => normalizeText(a) === normalizeText(b);

const FIELD_LABEL = { title: "タイトル", body: "本文" } as const;

/** 変わった項目の表示（「タイトルと本文」） */
export const changedLabel = (fields: readonly (keyof PreflightInput)[] | undefined) => (fields ?? []).map((k) => FIELD_LABEL[k]).join("と");

/** この run からのタスク化が終わっている（途中で止まったものは含めない） */
export const isMaterialized = (run: Pick<PreflightRun, "materialized" | "materialization">) =>
  !!run.materialized?.length && run.materialization?.done !== false;
