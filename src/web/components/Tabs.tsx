import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./ui.tsx";

export interface TabDef<T extends string> {
  id: T;
  label: string;
  hint?: string;
}

/**
 * タブの並び（設定・リリースノート）。矢印キー・Home・End で移る（選んだタブだけがフォーカスの順に入る）。
 * 保存していない変更があるタブには印（●・読み上げは「未保存」）を付ける。prefix はタブとパネルの id の頭
 */
export function Tabs<T extends string>({
  tabs,
  tab,
  unsaved,
  onSelect,
  label,
  prefix,
}: {
  tabs: readonly TabDef<T>[];
  tab: T;
  unsaved?: Partial<Record<T, boolean>>;
  onSelect: (t: T) => void;
  label: string;
  prefix: string;
}) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next].id;
    onSelect(id);
    refs.current[id]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800" onKeyDown={onKey}>
      {tabs.map((t) => {
        const on = t.id === tab;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${prefix}-tab-${t.id}`}
            aria-selected={on}
            aria-controls={`${prefix}-panel-${t.id}`}
            tabIndex={on ? 0 : -1}
            title={t.hint}
            onClick={() => onSelect(t.id)}
            className={cx(
              "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 font-medium whitespace-nowrap transition",
              on
                ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            {t.label}
            {unsaved?.[t.id] && (
              <span className="text-xs text-amber-600 dark:text-amber-400" title="保存していない変更があります">
                ●<span className="sr-only">（未保存）</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** 選んでいないタブは隠すだけ（書きかけの入力を残す） */
export function TabPanel<T extends string>({ id, tab, prefix, className, children }: { id: T; tab: T; prefix: string; className?: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${prefix}-panel-${id}`} aria-labelledby={`${prefix}-tab-${id}`} hidden={id !== tab} className={className}>
      {children}
    </div>
  );
}
