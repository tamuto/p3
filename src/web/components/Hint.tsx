import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * ツールチップ。OS 標準の title はカーソルを大きくしていると隠れて読めないので、
 * 要素の上側に大きめの文字で出す（入らなければ下側）。
 */
export function Hint({ content, children, className }: { content: ReactNode; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const show = () => ref.current && setRect(ref.current.getBoundingClientRect());
  const hide = () => setRect(null);
  return (
    <span ref={ref} className={className} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {rect && content && <Floating anchor={rect}>{content}</Floating>}
    </span>
  );
}

/** 要素の上（入らなければ下）に浮かせる */
function Floating({ anchor, children }: { anchor: DOMRect; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.top - 8, visible: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - w / 2), window.innerWidth - w - 8);
    const above = anchor.top - h - 10;
    setPos({ left, top: above >= 8 ? above : anchor.bottom + 10, visible: true });
  }, [anchor]);
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[100] max-w-sm rounded-md bg-slate-900 px-3 py-2 text-base leading-snug whitespace-pre-line text-white shadow-lg dark:bg-slate-700"
      style={{ left: pos.left, top: pos.top, visibility: pos.visible ? "visible" : "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * クリックで開く小さな一覧（同じ日・週・月にまとまった印の中から1つ選ぶ）。外をクリックすると閉じる。
 */
export function Picker({ anchor, items, onPick, onClose }: { anchor: DOMRect; items: { key: string; label: ReactNode }[]; onPick: (key: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[100] max-h-72 w-80 overflow-y-auto rounded-lg bg-white py-1 shadow-xl ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700"
      style={{ left: Math.min(anchor.left, window.innerWidth - 328), top: Math.min(anchor.bottom + 6, window.innerHeight - 300) }}
    >
      {items.map((it) => (
        <button key={it.key} onClick={() => onPick(it.key)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-700">
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
