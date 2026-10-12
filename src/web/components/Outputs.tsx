import { outputHref, outputLabel } from "../lib/outputs.ts";
import { cx } from "./ui.tsx";

/**
 * タスクの成果物。項目全体が http(s) の URL ならリンク（別のタブで開く）、それ以外（文章・パス）はそのまま文字で出す（lib/outputs.ts）。
 * compact: ボードのカードでは2行までにして、全文はマウスを乗せると出す。リンクを押してもカード（詳細）は開かない
 */
export function Outputs({ outputs, compact = false }: { outputs: readonly string[]; compact?: boolean }) {
  return (
    <ul className="mt-2 space-y-1">
      {outputs.map((o, i) => {
        const href = outputHref(o);
        return (
          // 同じ値が並んでもよい（そのまま並べる）
          <li key={`${i}:${o}`} className={cx("min-w-0 text-sm", compact && "line-clamp-2")} title={compact ? o : undefined}>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="break-all text-indigo-600 hover:underline dark:text-indigo-400"
              >
                ↗ {outputLabel(o.trim())}
              </a>
            ) : (
              <span className="break-words whitespace-pre-wrap text-slate-600 dark:text-slate-300">{o}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
