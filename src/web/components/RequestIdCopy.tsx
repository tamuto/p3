import { useEffect, useState } from "react";
import { copyNotice, copyText, type ClipboardLike, type CopyState } from "../lib/copy.ts";
import { buttonCls, cx } from "./ui.tsx";

/**
 * 要望 ID の表示とコピー（概要・Preflight のタイトルの上）。
 *   - ID は選択できる（クリックで全体を選べる）。コピーできないときは選んでコピーしてもらう
 *   - 結果は role="status" で支援技術にも伝える。成功は書き込みが終わってから出し、しばらくして消す
 *   - ボタンを押してもタイトルの入力欄からフォーカスを奪わない（入力中のタイトルを保存させない）
 */
export function RequestIdCopy({ id, clipboard }: { id: string; clipboard?: ClipboardLike }) {
  const [state, setState] = useState<CopyState | null>(null);
  useEffect(() => {
    if (!state) return;
    const t = setTimeout(() => setState(null), 5000);
    return () => clearTimeout(t);
  }, [state]);
  const notice = copyNotice(state, id);

  const copy = async () => {
    const target = id;
    const result = await copyText(target, clipboard ?? globalThis.navigator?.clipboard);
    setState({ id: target, result });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-sm text-slate-500 select-all dark:text-slate-400">{id}</span>
      <button
        type="button"
        aria-label="要望 ID をコピー"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void copy()}
        className={buttonCls("ghost", "px-2 py-0.5 text-sm focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none")}
      >
        コピー
      </button>
      <span role="status" className={cx("text-sm", notice?.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
        {notice?.text ?? ""}
      </span>
    </div>
  );
}
