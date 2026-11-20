import { createFileRoute, Link } from "@tanstack/react-router";
import type { ObserverStatus } from "../../../shared/status.ts";
import { fetchDefinitions, fetchStatus, type DefinitionListing } from "../../lib/api.ts";
import { observerScope } from "../../lib/scope.ts";
import { useLoad } from "../../lib/useLoad.ts";
import { linkCls, primaryCls, TargetLine } from "../../components/Target.tsx";

/**
 * /observer: 観測基盤の入口。起動状態と、このプロジェクトの観測の定義の一覧（登録・詳細への導線）。
 * プロジェクトを跨ぐ serve でプロジェクトを選んでいないときは、選ぶ一覧を出す（選ぶと /projects/<名前>/observer へ移る）。
 * observer の API だけを読む（tasks のプロジェクト情報・設定・イベントは読まない）
 */
export const Route = createFileRoute("/observer/")({ component: ObserverHome });

function ObserverHome() {
  const scope = observerScope();
  const status = useLoad<ObserverStatus>(fetchStatus);
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-5 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">観測基盤</h1>
        {status.kind === "ok" && (
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {status.value.state === "ready" ? "起動中" : status.value.state}・共通バージョン {status.value.version}
          </span>
        )}
        {status.kind === "error" && (
          <span role="alert" className="text-rose-600">
            起動状態を読めませんでした: {status.message}
          </span>
        )}
      </div>
      {scope.kind === "choose" ? <ChooseProject projects={scope.projects} /> : <DefinitionList />}
    </div>
  );
}

function ChooseProject({ projects }: { projects: { name: string; href: string; error?: string }[] }) {
  return (
    <section aria-labelledby="choose-heading" className="space-y-3">
      <h2 id="choose-heading" className="font-semibold">
        観測を登録するプロジェクトを選んでください
      </h2>
      {projects.length === 0 && <p className="text-slate-500">個人設定に登録したプロジェクトがありません（p3 init / p3 join で登録する）。</p>}
      <ul className="space-y-1">
        {projects.map((p) => (
          <li key={p.name}>
            {p.error ? (
              <span className="text-slate-500">
                {p.name}（開けません: {p.error}）
              </span>
            ) : (
              <a href={p.href} className={linkCls}>
                {p.name}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DefinitionList() {
  const load = useLoad<DefinitionListing>(fetchDefinitions);
  return (
    <section aria-labelledby="definitions-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="definitions-heading" className="font-semibold">
          観測の定義
        </h2>
        <Link to="/observer/new" className={primaryCls}>
          ＋ 観測を登録
        </Link>
      </div>
      {load.kind === "loading" && <p className="text-slate-500">読み込み中…</p>}
      {load.kind === "error" && (
        <p role="alert" className="text-rose-600">
          観測の定義を読めませんでした: {load.message}
        </p>
      )}
      {load.kind === "ok" && (
        <>
          <TargetLine target={load.value.target} />
          {load.value.unreadable.map((u) => (
            <p key={u.file} role="alert" className="text-amber-700 dark:text-amber-400">
              ⚠ 読めないファイル {u.file}: {u.reason}
            </p>
          ))}
          {load.value.definitions.length === 0 ? (
            <p className="text-slate-500">まだ観測の定義がありません。</p>
          ) : (
            <table className="w-full text-left">
              <thead className="text-sm text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="py-1 pr-3 font-normal">タイトル</th>
                  <th className="py-1 pr-3 font-normal">カテゴリ</th>
                  <th className="py-1 pr-3 font-normal">測定・手順</th>
                  <th className="py-1 font-normal">版</th>
                </tr>
              </thead>
              <tbody>
                {load.value.definitions.map((d) => (
                  <tr key={d.id} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="py-2 pr-3">
                      <Link to="/observer/$id" params={{ id: d.id }} className={linkCls}>
                        {d.title}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">{d.category}</td>
                    <td className="py-2 pr-3">
                      {d.measures.length}・{d.procedures.length}
                    </td>
                    <td className="py-2">v{d.rev}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

