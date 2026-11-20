import { Alert, buttonCls, Empty, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { filesOf, fileKey, MEASURE_TYPE_LABEL, type ObservationDefinition, type References } from "../../../../shared/definition.ts";
import { fetchDefinition, switchProcedure } from "../../../lib/api.ts";
import { useFileStates } from "../../../lib/files.ts";
import { useLoad } from "../../../lib/useLoad.ts";
import { ProcedureView } from "../../../components/ProcedureView.tsx";
import { SwitchForm } from "../../../components/SwitchForm.tsx";

/**
 * /observer/<ID>: 観測の定義の詳細。観測内容・測定項目・確認の手順（今の実行方法・置き換え候補・ファイルの有無・切り替えの履歴）。
 * 置き換え候補のスクリプトを用意して確かめたら、ここで切り替える（確かめた呼び出し方と結果を添える）
 */
export const Route = createFileRoute("/observer/$id/")({ component: DefinitionDetail });

function DefinitionDetail() {
  const { id } = Route.useParams();
  const [tick, setTick] = useState(0);
  const load = useLoad(() => fetchDefinition(id), `${id}:${tick}`);
  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:p-8">
      <Link to="/observer" className={linkCls}>
        ← 観測の一覧
      </Link>
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>観測の定義を読めませんでした: {load.message}</Alert>}
      {load.kind === "ok" && <Detail d={load.value.definition} refs={load.value.references} reload={() => setTick((t) => t + 1)} />}
    </div>
  );
}

function Detail({ d, refs, reload }: { d: ObservationDefinition; refs: References; reload: () => void }) {
  const files = useFileStates(filesOf(d.procedures).map((f) => fileKey(f.repo, f.path)));
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">{d.title}</h1>
          <p className="text-slate-600 dark:text-slate-400">
            {d.category || "カテゴリ未設定"}・版 v{d.rev}・<span data-aux>{d.id}</span>
          </p>
        </div>
        <Link to="/observer/$id/edit" params={{ id: d.id }} className={buttonCls("primary")}>
          編集・AI に提案を頼む
        </Link>
      </header>
      <section aria-labelledby="desc-heading" className="space-y-2">
        <h2 id="desc-heading" className="text-xl font-semibold">
          観測内容
        </h2>
        <p className="whitespace-pre-wrap">{d.description}</p>
      </section>
      <section aria-labelledby="expected-heading" className="space-y-2">
        <h2 id="expected-heading" className="text-xl font-semibold">
          期待する結果
        </h2>
        {d.expected ? <p className="whitespace-pre-wrap">{d.expected}</p> : <Empty>まだ書かれていません（編集で書ける）。</Empty>}
      </section>
      <section aria-labelledby="refs-heading" className="space-y-2">
        <h2 id="refs-heading" className="text-xl font-semibold">
          前提の観測と使う準備
        </h2>
        {refs.prerequisites.length + refs.preparations.length === 0 && <Empty>ありません（編集で選べる）。</Empty>}
        {refs.prerequisites.length > 0 && (
          <p>
            前提の観測（失敗したらこの観測は未確認）:{" "}
            {refs.prerequisites.map((r, i) => (
              <Fragment key={r.id}>
                {i > 0 && "・"}
                {r.title ? (
                  <Link to="/observer/$id" params={{ id: r.id }} className={linkCls}>
                    {r.title}
                  </Link>
                ) : (
                  `${r.id}（見つからない）`
                )}
              </Fragment>
            ))}
          </p>
        )}
        {refs.preparations.length > 0 && (
          <p>
            使う準備:{" "}
            {refs.preparations.map((r, i) => (
              <Fragment key={r.id}>
                {i > 0 && "・"}
                {r.name ? (
                  <Link to="/observer/preparations/$pid" params={{ pid: r.id }} className={linkCls}>
                    {r.name}
                  </Link>
                ) : (
                  `${r.id}（見つからない）`
                )}
              </Fragment>
            ))}
          </p>
        )}
      </section>
      <section aria-labelledby="m-heading" className="space-y-2">
        <h2 id="m-heading" className="text-xl font-semibold">
          測定項目
        </h2>
        {d.measures.length === 0 ? (
          <Empty>ありません。</Empty>
        ) : (
          <ul className="space-y-1">
            {d.measures.map((m) => (
              <li key={m.name}>
                <code>{m.name}</code>　{MEASURE_TYPE_LABEL[m.type]}
                {m.unit ? `（${m.unit}）` : ""}
                {m.description ? `　${m.description}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="p-heading" className="space-y-3">
        <h2 id="p-heading" className="text-xl font-semibold">
          確認の手順
        </h2>
        {d.procedures.length === 0 && <Empty>ありません。</Empty>}
        {d.procedures.map((p) => (
          <ProcedureView key={p.id} p={p} label={`${p.id}: ${p.title}`} measures={d.measures} files={files}>
            {p.replacement && (
              <SwitchForm label={p.id} replacement={p.replacement} files={files} onSwitch={(invoke, evidence) => switchProcedure(d.id, p.id, d.rev, invoke, evidence)} onDone={reload} />
            )}
          </ProcedureView>
        ))}
      </section>
      <p className="text-slate-600 dark:text-slate-400" data-aux>
        作成 {new Date(d.createdAt).toLocaleString()} {d.createdBy}／更新 {new Date(d.updatedAt).toLocaleString()} {d.updatedBy}
      </p>
    </>
  );
}
