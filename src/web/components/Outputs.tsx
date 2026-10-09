/** タスクの成果物（URL はリンク、それ以外はパス） */
export function Outputs({ outputs }: { outputs: string[] }) {
  return (
    <ul className="mt-2 space-y-0.5">
      {outputs.map((o) => (
        <li key={o} className="truncate text-sm">
          {/^https?:/.test(o) ? (
            <a href={o} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-indigo-600 hover:underline dark:text-indigo-400">
              ↗ {o.replace(/^https?:\/\/(www\.)?/, "")}
            </a>
          ) : (
            <span className="font-mono text-slate-500">{o}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
