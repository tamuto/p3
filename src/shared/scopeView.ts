import type { RefScope } from "./repos.ts";
import type { Evidence } from "./types.ts";

/**
 * Preflight の「調べた範囲」と「判断の根拠」の見せ方（CLI の p3 drafts と画面で同じ言葉にする）。
 * 調べた範囲（scope）は P3 が始めるときに決めたもの、根拠（evidence）は Codex が書き P3 が確かめたもの。
 */

export const SCOPE_STATUS_LABEL: Record<RefScope["status"], string> = {
  ok: "読んだ",
  unregistered: "見ていない（このマシンのパスが未登録）",
  missing: "見ていない（パスが無い）",
  notdir: "見ていない（フォルダでない）",
};

/** 根拠の場所（<参照先>:<ファイル> <箇所>） */
export const evidenceWhere = (e: Evidence) =>
  [e.repo && e.file ? `${e.repo}:${e.file}${e.location ? ` ${e.location}` : ""}` : "", e.commit ? `commit ${e.commit}` : ""].filter(Boolean).join(" / ");

/** git の履歴の表示（調べた範囲） */
export const historyLabel = (h: RefScope["history"]) =>
  !h ? "" : h.status === "ok" ? "git の履歴あり" : h.status === "shallow" ? `git の履歴は途中まで（${h.reason ?? "浅い clone"}）` : `git の履歴なし（${h.reason ?? "不明"}）`;

/** local: 手元のエージェントの run（コンテナのパスではなく、このマシンのパスで読んだ。共有の記録にはパスを出さない） */
export function scopeLines(scope: RefScope[] | undefined, opts: { local?: boolean } = {}): string[] {
  if (!scope) return ["調べた範囲: 記録なし（以前の評価）"];
  if (!scope.length) return ["調べた範囲: 参照先なし"];
  return [
    "調べた範囲:",
    ...scope.map(
      (s) =>
        `  ${s.status === "ok" ? "✓" : "✕"} ${s.name}${s.role ? `（${s.role}）` : ""}  ${s.status === "ok" ? (opts.local ? "このマシンのパスで読める" : `/workspace/${s.mount}`) : (s.reason ?? SCOPE_STATUS_LABEL[s.status])}${s.history ? `  ${historyLabel(s.history)}` : ""}`,
    ),
  ];
}

export function evidenceLines(evidence: Evidence[] | undefined): string[] {
  if (evidence === undefined) return ["判断の根拠: 記録なし（以前の評価）"];
  if (!evidence.length) return ["判断の根拠: なし"];
  return [
    "判断の根拠:",
    ...evidence.map((e) => {
      const where = evidenceWhere(e);
      return e.kind === "verified"
        ? `  確かめた  ${where} — ${e.claim}`
        : `  推測      ${e.claim}${where ? `（${where}）` : ""}${e.note ? `  ※${e.note}` : ""}`;
    }),
  ];
}
