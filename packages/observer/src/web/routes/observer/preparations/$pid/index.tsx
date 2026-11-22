import { Alert, Button, buttonCls, Empty, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { filesOf, fileKey } from "../../../../../shared/definition.ts";
import { SLOT_HINT, SLOT_LABEL, SLOTS } from "../../../../../shared/preparation.ts";
import { deletePreparation, fetchPreparation, switchSlot, type PreparationDetail } from "../../../../lib/api.ts";
import { useFileStates } from "../../../../lib/files.ts";
import { useLoad } from "../../../../lib/useLoad.ts";
import { ExecutableView } from "../../../../components/ProcedureView.tsx";
import { SwitchForm } from "../../../../components/SwitchForm.tsx";

/**
 * /observer/preparations/<ID>: 準備の詳細。説明・占有・確かめ・前処理・後処理（今の実行方法・置き換え候補・切り替えの履歴）と、この準備を使う観測。
 * 置き換え候補のスクリプトを用意して確かめたらここで切り替える。使う観測が無いときだけ消せる
 */
export const Route = createFileRoute("/observer/preparations/$pid/")({ component: PreparationPage });

function PreparationPage() {
  const { pid } = Route.useParams();
  const [tick, setTick] = useState(0);
  const load = useLoad(() => fetchPreparation(pid), `${pid}:${tick}`);
  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:p-8">
      <Link to="/observer/preparations" className={linkCls}>
        ← 準備の一覧
      </Link>
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>準備を読めませんでした: {load.message}</Alert>}
      {load.kind === "ok" && <Detail v={load.value} reload={() => setTick((t) => t + 1)} />}
    </div>
  );
}

function Detail({ v: { preparation: p, usedBy }, reload }: { v: PreparationDetail; reload: () => void }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const files = useFileStates(filesOf(SLOTS.flatMap((s) => (p[s] ? [p[s]] : []))).map((f) => fileKey(f.repo, f.path)));
  const remove = () => {
    if (!window.confirm(`準備「${p.name}」を消しますか？`)) return;
    deletePreparation(p.id, p.rev).then(() => void navigate({ to: "/observer/preparations" }), (e: Error) => setError(e.message));
  };
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">{p.name}</h1>
          <p className="text-fg-3">
            版 v{p.rev}・<span data-aux>{p.id}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link to="/observer/preparations/$pid/edit" params={{ pid: p.id }} className={buttonCls("primary")}>
            編集
          </Link>
          <Button onClick={remove} disabled={usedBy.definitions.length > 0}>
            消す
          </Button>
        </div>
      </header>
      {error && <Alert box>消せませんでした: {error}</Alert>}
      <section aria-labelledby="prep-desc" className="space-y-2">
        <h2 id="prep-desc" className="text-xl font-semibold">
          説明
        </h2>
        {p.description ? <p className="whitespace-pre-wrap">{p.description}</p> : <Empty>まだ書かれていません（編集で書ける）。</Empty>}
      </section>
      <section aria-labelledby="prep-exclusive" className="space-y-2">
        <h2 id="prep-exclusive" className="text-xl font-semibold">
          占有（同時に走らせないもの）
        </h2>
        <p>{p.exclusive.join("・") || "なし"}</p>
      </section>
      {SLOTS.map((s) => (
        <section key={s} aria-labelledby={`prep-${s}`} className="space-y-2">
          <h2 id={`prep-${s}`} className="text-xl font-semibold">
            {SLOT_LABEL[s]}
          </h2>
          <p className="text-fg-3">{SLOT_HINT[s]}</p>
          {p[s] ? (
            <ExecutableView e={p[s]} label={SLOT_LABEL[s]} files={files}>
              {p[s].replacement && <SwitchForm label={SLOT_LABEL[s]} replacement={p[s].replacement} files={files} onSwitch={(invoke, evidence) => switchSlot(p.id, s, p.rev, invoke, evidence)} onDone={reload} />}
            </ExecutableView>
          ) : (
            <Empty>ありません。</Empty>
          )}
        </section>
      ))}
      <section aria-labelledby="prep-used" className="space-y-2">
        <h2 id="prep-used" className="text-xl font-semibold">
          この準備を使う観測
        </h2>
        {usedBy.unreadable.length > 0 && <Alert warn>読めない観測のファイルがあり、全部は確かめられません（{usedBy.unreadable.map((u) => u.file).join("・")}）</Alert>}
        {usedBy.definitions.length === 0 ? (
          <Empty>まだどの観測も使っていません。</Empty>
        ) : (
          <>
            <ul className="list-disc space-y-1 pl-6">
              {usedBy.definitions.map((d) => (
                <li key={d.id}>
                  <Link to="/observer/$id" params={{ id: d.id }} className={linkCls}>
                    {d.title}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="text-fg-3">使っている観測から外すまで、この準備は消せません。</p>
          </>
        )}
      </section>
      <p className="text-fg-3" data-aux>
        作成 {new Date(p.createdAt).toLocaleString()} {p.createdBy}／更新 {new Date(p.updatedAt).toLocaleString()} {p.updatedBy}
      </p>
    </>
  );
}
