import type { RepoOutput } from "../../shared/types.ts";
import { outputHref, outputLabel } from "../lib/outputs.ts";
import { cx } from "./ui.tsx";

/**
 * タスクの成果物。項目全体が http(s) の URL ならリンク（別のタブで開く）、それ以外（文章・パス）はそのまま文字で出す（lib/outputs.ts）。
 * compact: ボードのカードでは2行までにして、全文はマウスを乗せると出す。リンクを押してもカード（詳細）は開かない
 */
export function Outputs({ outputs, repoOutputs = [], compact = false }: { outputs: readonly string[]; repoOutputs?: readonly RepoOutput[]; compact?: boolean }) {
  // リポジトリごとの成果物は、どのリポジトリのものかを前に付ける
  const items = [...outputs.map((o) => ({ o, repo: undefined as string | undefined })), ...repoOutputs.map((x) => ({ o: x.output, repo: x.repo }))];
  return (
    <ul className="mt-2 space-y-1">
      {items.map(({ o, repo }, i) => {
        const href = outputHref(o);
        return (
          // 同じ値が並んでもよい（そのまま並べる）
          <li key={`${i}:${repo ?? ""}:${o}`} className={cx("min-w-0 text-sm", compact && "line-clamp-2")} title={compact ? `${repo ? `${repo}: ` : ""}${o}` : undefined}>
            {repo && <span className="mr-1 rounded bg-slate-100 px-1 text-slate-600 dark:bg-slate-700 dark:text-slate-300">{repo}</span>}
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
