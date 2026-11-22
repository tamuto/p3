import { useEffect, useState } from "react";
import { projectPath } from "@infodb/p3-tasks/web/lib/scope.ts";
import { Logo } from "@infodb/p3-tasks/web/components/Logo.tsx";
import { Alert, Badge, Button, Empty } from "@infodb/p3-shared/web/ui.tsx";

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
 * プロジェクトを跨ぐ serve の入口（/。登録が1つで開けるなら Boot がそのプロジェクトへ移る）と、開けなかったとき。
 * 開けないプロジェクトは名前と理由を出し、ほかは選べる。一覧に戻ったとき・このタブに戻ったときと「一覧を読み直す」で読み直す
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
  // 一覧に戻ったら読み直す: 戻るでページが保存から戻ったとき・このタブに戻ったとき（開いたときは Boot が読んだばかり）
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && void reload();
    const onVisible = () => document.visibilityState === "visible" && void reload();
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <div className="min-h-screen bg-surface text-fg-strong">
      <header className="flex items-center gap-3 border-b border-line px-5 py-2.5">
        <Logo />
        <span className="font-medium">プロジェクトを選ぶ</span>
      </header>
      <main className="mx-auto max-w-2xl space-y-4 p-5 sm:p-8">
        <p className="text-fg-3">
          個人設定に登録したプロジェクトを跨いで開いています（p3 serve --all-projects）。選んだプロジェクトで、要望・タスク・Preflight をいつもどおり扱えます。
        </p>
        {problem && (
          <Alert box className="space-y-1">
            <p className="font-medium break-words">{requested ? `「${requested}」を開けません。` : ""}{problem}</p>
            <p className="text-base">ほかのプロジェクトは選べます。登録は CLI で確かめて直します（p3 project ls / p3 project add &lt;名前&gt; &lt;フォルダ&gt;）。直したら一覧を読み直してください。</p>
          </Alert>
        )}
        {listing.configError && (
          <Alert box>
            {listing.configError}
          </Alert>
        )}
        {error && <p className="text-base text-danger">{error}</p>}

        {listing.projects.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-lg ring-1 ring-line">
            {listing.projects.map((p) => (
              <li key={p.name}>
                {p.state === "ok" ? (
                  // 行全体（余白を含む）を1つのリンクにする。名前の文字だけを狙わなくてよい
                  <a
                    href={`${projectPath(p.name)}/`}
                    className="flex items-center gap-3 p-4 font-medium text-accent transition hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
                  >
                    <span className="min-w-0 flex-1 break-words">{p.name}</span>
                    <span aria-hidden className="text-fg-4">
                      →
                    </span>
                  </a>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 p-4">
                    <span className="font-medium">{p.name}</span>
                    <Badge tone="rose">開けません</Badge>
                    {p.error && <p className="w-full text-base break-words text-danger">{p.error}</p>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            登録されたプロジェクトがありません。管理したいリポジトリの中で p3 init（新しく作る）か p3 join（参加する）で登録してから、一覧を読み直してください。
          </Empty>
        )}

        {listing.invalid.length > 0 && (
          <div className="space-y-1 text-base">
            <p className="font-medium text-warn">個人設定にあるが使えない登録:</p>
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
