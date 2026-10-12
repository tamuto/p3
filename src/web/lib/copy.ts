/**
 * 文字列をクリップボードへ渡す（要望 ID のコピー）。画面の部品から切り出して、Node でテストする。
 *
 *   - Clipboard API が無い（http で別のマシンから開いたときなど、安全でない接続では navigator.clipboard が無い）→ unavailable
 *   - 書き込みを拒まれた（権限・フォーカスが無いなど）→ denied。例外は外へ出さない
 *   - 書き込みが終わってから copied を返す（成功はこの後にだけ知らせる）
 */
export type CopyResult = "copied" | "denied" | "unavailable";

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export async function copyText(text: string, clipboard: ClipboardLike | undefined): Promise<CopyResult> {
  if (typeof clipboard?.writeText !== "function") return "unavailable";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "denied";
  }
}

export const COPY_MESSAGE: Record<CopyResult, string> = {
  copied: "コピーしました",
  denied: "コピーできませんでした。ID を選択してコピーしてください",
  unavailable: "このブラウザではコピーできません。ID を選択してコピーしてください",
};

/** コピーの結果。どの ID の結果かを一緒に持つ */
export interface CopyState {
  id: string;
  result: CopyResult;
}

/** 今の ID の結果だけを知らせる（別の要望へ移ったら、前の要望の結果は出さない） */
export function copyNotice(state: CopyState | null, current: string): { text: string; ok: boolean } | null {
  if (!state || state.id !== current) return null;
  return { text: COPY_MESSAGE[state.result], ok: state.result === "copied" };
}
