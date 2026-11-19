import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { OBSERVER_API, type ObserverStatus } from "../../shared/status.ts";

/**
 * /observer: observer の起動確認のページ（入口のルート一覧に付く。外枠とナビゲーションは入口の __root.tsx）。
 * observer の API（GET /api/observer/status）だけを読む。tasks のプロジェクト情報・設定・イベントは読まない
 */
export const Route = createFileRoute("/observer")({ component: ObserverPage });

const STATE_LABEL: Record<ObserverStatus["state"], string> = { ready: "起動中" };

type Load = { kind: "loading" } | { kind: "ok"; status: ObserverStatus } | { kind: "error"; message: string };

function ObserverPage() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  useEffect(() => {
    let alive = true;
    fetch(`${OBSERVER_API}/status`, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as ObserverStatus & { error?: string };
        if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
        return data;
      })
      .then(
        (status) => alive && setLoad({ kind: "ok", status }),
        (e: Error) => alive && setLoad({ kind: "error", message: e.message }),
      );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-5 py-8">
      <h1 className="text-2xl font-bold">観測基盤</h1>
      <section aria-labelledby="observer-status" className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h2 id="observer-status" className="mb-3 font-semibold">
          起動状態
        </h2>
        {load.kind === "loading" && <p className="text-slate-500">読み込み中…</p>}
        {load.kind === "error" && (
          <p role="alert" className="text-rose-600">
            起動状態を読めませんでした: {load.message}
          </p>
        )}
        {load.kind === "ok" && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-2">
            <dt className="text-slate-600 dark:text-slate-400">状態</dt>
            <dd>{STATE_LABEL[load.status.state]}</dd>
            <dt className="text-slate-600 dark:text-slate-400">共通バージョン</dt>
            <dd>{load.status.version}</dd>
            <dt className="text-slate-600 dark:text-slate-400">有効な製品</dt>
            <dd>{(load.status.products ?? ["observer"]).map((p) => `p3-${p}`).join("、")}</dd>
          </dl>
        )}
      </section>
      <p className="text-slate-500 dark:text-slate-400">観測データの収集・保存はまだありません（準備中）。</p>
    </div>
  );
}
