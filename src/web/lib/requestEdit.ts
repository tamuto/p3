import type { InputMatch } from "../../shared/types.ts";
import { ApiError } from "./api.ts";

/**
 * 要望のタイトル・本文の編集と、評価対象（Preflight が評価した内容）との食い違いの表示。
 * 評価のあとでタイトル・本文が変わった run からはタスク化しない（サーバが 409 code: stale_input で断る）。
 */

export const UNSAVED_BLOCKED = "タイトルか本文が未保存です。保存するかキャンセルしてください";

/** 未保存の項目（Preflight の開始とタスク化を止める） */
export function unsavedFields(s: { title: boolean; body: boolean }): string[] {
  return [...(s.title ? ["タイトル"] : []), ...(s.body ? ["本文"] : [])];
}

const FIELD = { title: "タイトル", body: "本文" } as const;

/**
 * 表示中の run の評価対象と今の要望の食い違い。同じなら null。
 * done: この run からタスク化済み（取り消したようには見せない）
 */
export function staleNotice(m: InputMatch | undefined, opts: { done: boolean }): { title: string; text: string } | null {
  if (!m || m.status === "same") return null;
  const what =
    m.status === "changed"
      ? `この評価のあとで要望の${(m.changed ?? []).map((k) => FIELD[k]).join("と")}が変わりました。`
      : `この評価が何を評価したか確かめられません（${m.reason ?? "不明"}）。`;
  return opts.done
    ? { title: "表示中の評価は、今の要望とは違う内容に対するものです", text: `${what}この評価からのタスク化は済んでいます（作ったタスクはそのまま残ります）。今の内容で見直すなら、もう一度 Preflight を実行してください。` }
    : {
        title: "表示中の評価と今の要望が違います",
        text: `${what}古い評価からはタスク化できません。もう一度 Preflight を実行してください（既存のタスク・過去の評価・メモは残ります）。この評価のままタスク化するなら、要望を評価した時点の内容に戻してください。`,
      };
}

/** タスク化の失敗の表示。409 は code で分ける（評価のあとで要望が変わった / 置き換えられるタスクが他で更新された） */
export function materializeErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) {
    const code = (e.body as { code?: string } | null)?.code;
    if (code === "stale_input") return e.message;
    return "置き換えられるタスクが他で更新されました。内容を確かめて、もう一度タスク化してください";
  }
  return (e as Error).message;
}

/** 本文の保存の失敗の表示（入力は消さない） */
export function bodySaveErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) return "保存できませんでした: 本文が他で更新されています。入力は残してあります。最新の本文を確かめて取り込んでください";
  if (e instanceof ApiError && e.status === 404) return "この要望は見つからないので保存しません。入力は残してあります（必要ならコピーしてください）";
  return `保存できませんでした: ${(e as Error).message}。入力は残してあります`;
}

/** 長い本文は、知らせる欄では先頭だけ見せる */
export function excerpt(s: string, max = 80): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one || "（空）";
}
