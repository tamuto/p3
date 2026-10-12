import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Request } from "../../shared/types.ts";
import { tagCandidates, toggleTag } from "../lib/requestFilter.ts";
import { buttonCls, cx, inputCls } from "./ui.tsx";

/** 一度に並べる候補の上限（多いときは検索で絞ってもらう） */
const MAX_SHOWN = 200;

/**
 * 進捗のタグの絞り込み（開閉式・検索つきの複数選択）。選んだもののどれかが付いている要望（OR）。
 * ヘッダーにはボタンだけを置き、候補は開いた中に高さを決めて並べる（候補が多くてもヘッダーは伸びない）。
 * 選んだタグがどの要望にも無くなっても、選択中に残して外せるようにする（黙って外さない）。
 */
export function TagFilter({
  requests,
  selected,
  onChange,
}: {
  requests: readonly { request: Pick<Request, "tags"> }[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const all = useMemo(() => tagCandidates(requests), [requests]);
  const shown = useMemo(() => tagCandidates(requests, query), [requests, query]);
  const known = new Set(all.map((c) => c.tag));
  const missing = selected.filter((t) => !known.has(t));
  // 開いた中はボタンの下に、画面の幅に収まるよう置く（狭い画面でボタンが右にあってもはみ出さない）
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>();
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = button.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(384, window.innerWidth - 32);
      setPos({ top: r.bottom + 4, left: Math.max(16, Math.min(r.left, window.innerWidth - width - 16)), width });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // 外をクリック・Escape で閉じる（Escape はボタンにフォーカスを戻す）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!all.length && !selected.length) return null;
  return (
    <div ref={root}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        title={selected.length ? `選択中: ${selected.join("、")}` : "タグで絞り込む"}
        onClick={() => setOpen((o) => !o)}
        className={buttonCls(selected.length ? "primary" : "secondary", "py-1 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none")}
      >
        タグ{selected.length ? `: ${selected.length} 件` : ""}
        <span aria-hidden className="text-xs">
          ▾
        </span>
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="タグで絞り込む"
          style={pos}
          className="fixed z-50 space-y-2 rounded-lg bg-white p-3 shadow-lg ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700"
        >
          <input
            autoFocus
            type="search"
            className={inputCls}
            placeholder="タグを検索（部分一致）"
            aria-label="タグを検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {selected.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-sm text-slate-500">
                <span>選択中 {selected.length} 件（どれかが付いている要望）</span>
                <button type="button" className="underline hover:text-slate-800 dark:hover:text-slate-200" onClick={() => onChange([])}>
                  すべて解除
                </button>
              </div>
              <ul className="flex max-h-24 flex-wrap gap-1 overflow-y-auto" aria-label="選択中のタグ">
                {selected.map((t) => (
                  <li key={t} className="inline-flex max-w-full items-start gap-1 rounded bg-indigo-50 py-0.5 pr-0.5 pl-2 text-sm text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">
                    <span className="min-w-0 break-all">
                      {t}
                      {!known.has(t) && <span className="text-slate-500">（該当なし）</span>}
                    </span>
                    <button
                      type="button"
                      aria-label={`タグ「${t}」の選択を外す`}
                      onClick={() => onChange(selected.filter((x) => x !== t))}
                      className="shrink-0 rounded px-1 hover:bg-indigo-100 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none dark:hover:bg-indigo-900"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul className="max-h-64 overflow-y-auto" aria-label="タグの候補">
            {shown.slice(0, MAX_SHOWN).map((c) => (
              <li key={c.tag}>
                <label className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 hover:bg-slate-50 dark:hover:bg-slate-800">
                  <input type="checkbox" className="mt-1 shrink-0" checked={selected.includes(c.tag)} onChange={() => onChange(toggleTag(selected, c.tag))} />
                  <span className="min-w-0 flex-1 break-all">{c.tag}</span>
                  <span className="shrink-0 text-sm text-slate-400">{c.count}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className={cx("text-sm text-slate-500", !shown.length || shown.length > MAX_SHOWN ? "" : "sr-only")} role="status">
            {!shown.length
              ? query
                ? "一致するタグはありません"
                : "タグはありません"
              : shown.length > MAX_SHOWN
                ? `候補 ${shown.length} 件のうち ${MAX_SHOWN} 件を表示。検索で絞り込んでください`
                : `候補 ${shown.length} 件`}
          </p>
          {missing.length > 0 && <p className="text-sm text-slate-500">「該当なし」は今どの要望にも付いていないタグです（選択は残しています）</p>}
        </div>
      )}
    </div>
  );
}
