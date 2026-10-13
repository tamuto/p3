import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReleaseNoteSummary, ReleaseWarning } from "../../shared/types.ts";
import { ReleaseNotePanel } from "../components/releaseNotes/ReleaseNotePanel.tsx";
import { cx, Empty } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { useAppData } from "../lib/appData.tsx";
import { latestOnly, STALE } from "../lib/latest.ts";
import { optionalString } from "../lib/search.ts";

/**
 * リリースノート（マイルストーンごとに1件）。左でマイルストーンを選び（URL の ?m=）、右で対象の要望と警告・機能の要約の生成・
 * 本文の編集と保存・ダウンロードを行う。規則（収録・警告・材料）はサーバ（core/releaseNotes）のもので、画面では判定しない。
 * 狭い画面では一覧の下に詳細を並べる。
 */
export const Route = createFileRoute("/release-notes")({
  validateSearch: (s: Record<string, unknown>): { m?: string } => ({ m: optionalString(s.m) }),
  component: ReleaseNotesPage,
});

function ReleaseNotesPage() {
  const { tick } = useAppData();
  const { m } = Route.useSearch();
  const [list, setList] = useState<{ milestones: ReleaseNoteSummary[]; warnings: ReleaseWarning[] }>();
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(latestOnly());

  const load = useCallback(async () => {
    try {
      const r = await latest.current.run(() => api.releaseNotes());
      if (r === STALE) return;
      setList(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, tick]);

  const selected = m ?? list?.milestones[0]?.milestone;
  return (
    <div className="w-full space-y-6 px-4 pt-6 pb-10 sm:px-6 lg:px-8 lg:pt-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">リリースノート</h1>
        <p className="text-slate-500 dark:text-slate-400">
          マイルストーンごとに、対応済・完了済の要望のタスクの変更の記録から機能の要約をまとめます。生成した案は確かめてから保存します。
        </p>
      </header>
      {error && (
        <p role="alert" className="text-rose-600">
          一覧を読み込めませんでした: {error}{" "}
          <button type="button" className="underline" onClick={() => void load()}>
            もう一度
          </button>
        </p>
      )}
      {!list ? (
        !error && <p className="text-slate-500">Loading…</p>
      ) : !list.milestones.length ? (
        <Empty>
          マイルストーンがありません。
          <Link to="/settings" search={{ tab: "project" }} className="underline">
            設定
          </Link>
          で作り、要望に付けてください。
        </Empty>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <MilestoneList items={list.milestones} warnings={list.warnings} selected={selected} />
          {selected && <ReleaseNotePanel key={selected} milestone={selected} />}
        </div>
      )}
    </div>
  );
}

function MilestoneList({ items, warnings, selected }: { items: ReleaseNoteSummary[]; warnings: ReleaseWarning[]; selected?: string }) {
  return (
    <nav aria-label="マイルストーン" className="space-y-2">
      <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">マイルストーン</h2>
      <ul className="space-y-1">
        {items.map((m) => (
          <li key={m.milestone}>
            <Link
              to="/release-notes"
              search={{ m: m.milestone }}
              aria-current={m.milestone === selected ? "page" : undefined}
              className={cx(
                "block rounded-md px-3 py-2 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none",
                m.milestone === selected ? "bg-indigo-50 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200" : "hover:bg-slate-100 dark:hover:bg-slate-800",
              )}
            >
              <span className="block font-medium break-words">
                {m.title} <span className="font-mono text-sm text-slate-500">{m.milestone}</span>
              </span>
              <span className="block text-sm text-slate-500 dark:text-slate-400">
                {noteLabel(m)}・要望 {m.requests} 件{m.done ? "・リリース済み" : ""}
              </span>
              {!m.known && <span className="block text-sm text-amber-700 dark:text-amber-300">⚠ project.yaml にありません</span>}
            </Link>
          </li>
        ))}
      </ul>
      {warnings.map((w) => (
        <p key={`${w.code}:${w.target}`} className="text-sm text-amber-700 dark:text-amber-300">
          ⚠ {w.message}
        </p>
      ))}
    </nav>
  );
}

const noteLabel = (m: ReleaseNoteSummary) => (m.note.state === "ok" ? "保存済み" : m.note.state === "invalid" ? "ノートを読めません" : "ノートなし");
