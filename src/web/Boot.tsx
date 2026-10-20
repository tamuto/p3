import { useCallback, useEffect, useState } from "react";
import { App } from "./App.tsx";
import { ProjectChooser, type ProjectListing } from "./components/ProjectChooser.tsx";
import { fixScope, projectFromPath, projectPath } from "./lib/scope.ts";

type BootState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "app" }
  /** プロジェクトを跨ぐ serve で、まだ選んでいない・開けない（problem に理由） */
  | { kind: "chooser"; listing: ProjectListing; requested?: string; problem?: string };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

/**
 * ページを開いたときに、この画面の対象を決める（lib/scope.ts）。
 *   通常の serve: そのまま画面を出す
 *   プロジェクトを跨ぐ serve: URL の /projects/<名前> を一覧で確かめ、開けたら画面を出す。選んでいない・登録に無い・
 *   開けないときは一覧（選ぶだけ。1件でも黙って決めない）
 */
async function boot(): Promise<BootState> {
  const { mode } = await getJson<{ mode: string }>("/api/mode");
  if (mode !== "all-projects") {
    fixScope({ mode: "single" });
    return { kind: "app" };
  }
  const listing = await getJson<ProjectListing>("/api/projects");
  const requested = projectFromPath(location.pathname);
  if (!requested) return { kind: "chooser", listing };
  const p = listing.projects.find((x) => x.name === requested);
  if (!p) return { kind: "chooser", listing, requested, problem: `プロジェクト「${requested}」は個人設定に登録されていません。` };
  if (p.state === "error") return { kind: "chooser", listing, requested, problem: p.error };
  // 開けるかを先に確かめる（開けなければ理由を出して一覧に戻す。読み込み中のままにしない）
  try {
    await getJson(`/api${projectPath(requested)}/project`);
  } catch (e) {
    return { kind: "chooser", listing, requested, problem: (e as Error).message };
  }
  fixScope({ mode: "all-projects", project: requested, generation: p.generation });
  return { kind: "app" };
}

export function Boot() {
  const [state, setState] = useState<BootState>({ kind: "loading" });
  const start = useCallback(() => {
    setState({ kind: "loading" });
    boot().then(setState, (e: Error) => setState({ kind: "error", message: e.message }));
  }, []);
  useEffect(start, [start]);

  if (state.kind === "app") return <App />;
  if (state.kind === "chooser") return <ProjectChooser initial={state.listing} requested={state.requested} problem={state.problem} />;
  if (state.kind === "error")
    return (
      <div className="space-y-2 p-8">
        <p role="alert" className="text-rose-600">
          画面を開けませんでした: {state.message}
        </p>
        <button type="button" className="underline" onClick={start}>
          もう一度読み込む
        </button>
      </div>
    );
  return <div className="p-8 text-slate-500">Loading…</div>;
}
