import { useState } from "react";
import { projectPath } from "../lib/scope.ts";
import { Logo } from "./Logo.tsx";
import { Badge, Button, Empty } from "./ui.tsx";

/** GET /api/projects の応答（プロジェクトを跨ぐ serve） */
export interface ProjectListing {
  projects: { name: string; generation: string; state: "ok" | "error"; error?: string; open: boolean }[];
  invalid: { name: string; reason: string }[];
  configError?: string;
}

export async function fetchProjects(): Promise<ProjectListing> {
  const res = await fetch("/api/projects", { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as ProjectListing & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

/**
 * プロジェクトを跨ぐ serve の入口（/）と、開けなかったとき。個人設定に登録したプロジェクトを選ぶだけで、1件でも自動では開かない。
 * 開けないプロジェクトは名前と理由を出し、ほかは選べる。登録を直したら「一覧を読み直す」
 */
export function ProjectChooser({ initial, requested, problem }: { initial: ProjectListing; requested?: string; problem?: string }) {
  const [listing, setListing] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    setBusy(true);
    try {
      setListing(await fetchProjects());
      setError(null);
    } catch (e) {
      setError(`一覧を読み直せませんでした（表示は前の内容のまま）: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center gap-3 border-b border-slate-200 px-5 py-2.5 dark:border-slate-800">
        <Logo />
        <span className="font-medium">プロジェクトを選ぶ</span>
      </header>
      <main className="mx-auto max-w-2xl space-y-4 p-5 sm:p-8">
        <p className="text-slate-600 dark:text-slate-400">
          個人設定に登録したプロジェクトを跨いで開いています（p3 serve --all-projects）。選んだプロジェクトで、要望・タスク・Preflight をいつもどおり扱えます。
        </p>
        {problem && (
          <div role="alert" className="space-y-1 rounded-md bg-rose-50 p-3 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
            <p className="font-medium break-words">{requested ? `「${requested}」を開けません。` : ""}{problem}</p>
            <p className="text-sm">ほかのプロジェクトは選べます。登録は CLI で確かめて直します（p3 project ls / p3 project add &lt;名前&gt; &lt;フォルダ&gt;）。直したら一覧を読み直してください。</p>
          </div>
        )}
        {listing.configError && (
          <p role="alert" className="rounded-md bg-rose-50 p-3 break-words text-rose-800 dark:bg-rose-950 dark:text-rose-300">
            {listing.configError}
          </p>
        )}
        {error && <p className="text-sm text-rose-600">{error}</p>}

        {listing.projects.length ? (
          <ul className="divide-y divide-slate-200 rounded-lg ring-1 ring-slate-200 dark:divide-slate-800 dark:ring-slate-800">
            {listing.projects.map((p) => (
              <li key={p.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                {p.state === "ok" ? (
                  <a href={`${projectPath(p.name)}/`} className="font-medium text-indigo-700 hover:underline dark:text-indigo-300">
                    {p.name}
                  </a>
                ) : (
                  <span className="font-medium">{p.name}</span>
                )}
                {p.state === "error" && <Badge tone="rose">開けません</Badge>}
                {p.error && <p className="w-full text-sm break-words text-rose-700 dark:text-rose-300">{p.error}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            登録されたプロジェクトがありません。管理したいリポジトリの中で p3 init（新しく作る）か p3 join（参加する）で登録してから、一覧を読み直してください。
          </Empty>
        )}

        {listing.invalid.length > 0 && (
          <div className="space-y-1 text-sm">
            <p className="font-medium text-amber-700 dark:text-amber-400">個人設定にあるが使えない登録:</p>
            <ul className="list-disc pl-5">
              {listing.invalid.map((i) => (
                <li key={i.name} className="break-words">
                  {i.name}: {i.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Button onClick={() => void reload()} disabled={busy}>
          {busy ? "読み直しています…" : "一覧を読み直す"}
        </Button>
      </main>
    </div>
  );
}
