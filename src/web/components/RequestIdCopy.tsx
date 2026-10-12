import { useEffect, useState } from "react";
import { copyNotice, copyText, type ClipboardLike, type CopyState } from "../lib/copy.ts";
import { buttonCls, cx } from "./ui.tsx";

/**
 * 要望 ID の表示とコピー（概要・Preflight のタイトルの上）。
 *   - ID は選択できる（クリックで全体を選べる）。コピーできないときは選んでコピーしてもらう
 *   - ボタンは枠つきで、コピーのアイコンと文字を出す（成功したらアイコンをチェックにする）
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
        className={buttonCls("secondary", "px-2 py-0.5 text-sm focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none")}
      >
        {notice?.ok ? <CheckIcon /> : <CopyIcon />}
        コピー
      </button>
      <span role="status" className={cx("text-sm", notice?.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
        {notice?.text ?? ""}
      </span>
    </div>
  );
}

const iconProps = {
  "aria-hidden": true,
  viewBox: "0 0 16 16",
  className: "size-3.5",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** 重なった2枚の紙 */
function CopyIcon() {
  return (
    <svg {...iconProps}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...iconProps} className="size-3.5 text-emerald-600 dark:text-emerald-400">
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}
