import { Alert, Empty, Loading, buttonCls, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link } from "@tanstack/react-router";
import { MEASURE_TYPE_LABEL, PROCEDURE_KIND_LABEL, type ObservationDefinition, type Procedure } from "../../../../shared/definition.ts";
import { fetchDefinition } from "../../../lib/api.ts";
import { useLoad } from "../../../lib/useLoad.ts";

/** /observer/<ID>: 観測の定義の詳細（項目・測定項目・確認の手順と、手順が測る項目） */
export const Route = createFileRoute("/observer/$id/")({ component: DefinitionDetail });

function DefinitionDetail() {
  const { id } = Route.useParams();
  const load = useLoad(() => fetchDefinition(id), id);
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-5 py-8">
      <Link to="/observer" className={linkCls}>
        ← 観測の一覧
      </Link>
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>観測の定義を読めませんでした: {load.message}</Alert>}
      {load.kind === "ok" && <Detail d={load.value.definition} />}
    </div>
  );
}

function Detail({ d }: { d: ObservationDefinition }) {
  const measureOf = (name: string) => d.measures.find((m) => m.name === name);
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{d.title}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {d.id}・版 {d.rev}・カテゴリ {d.category}
          </p>
        </div>
        <Link to="/observer/$id/edit" params={{ id: d.id }} className={buttonCls("primary")}>
          編集
        </Link>
      </div>
      <section aria-labelledby="desc-heading" className="space-y-1">
        <h2 id="desc-heading" className="font-semibold">
          観測内容
        </h2>
        <p className="whitespace-pre-wrap">{d.description}</p>
      </section>
      <section aria-labelledby="m-heading" className="space-y-2">
        <h2 id="m-heading" className="font-semibold">
          測定項目
        </h2>
        {d.measures.length === 0 ? (
          <Empty>ありません。</Empty>
        ) : (
          <ul className="space-y-1">
            {d.measures.map((m) => (
              <li key={m.name}>
                <span className="font-mono">{m.name}</span>　{MEASURE_TYPE_LABEL[m.type]}
                {m.unit ? `（${m.unit}）` : ""}
                {m.description ? `　${m.description}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="p-heading" className="space-y-2">
        <h2 id="p-heading" className="font-semibold">
          確認の手順
        </h2>
        {d.procedures.length === 0 && <Empty>ありません。</Empty>}
        {d.procedures.map((p, i) => (
          <article key={i} aria-label={`手順 ${i + 1}: ${p.title}`} className="space-y-1 rounded border border-slate-200 p-3 dark:border-slate-800">
            <h3 className="font-medium">
              <span className="mr-2 rounded bg-slate-100 px-1.5 text-sm dark:bg-slate-800">{PROCEDURE_KIND_LABEL[p.kind]}</span>
              {p.title}
            </h3>
            <ProcedureBody p={p} />
            <p className="text-sm">
              測る項目:{" "}
              {p.measures.length === 0
                ? "なし"
                : p.measures.map((n) => {
                    const m = measureOf(n);
                    return `${n}（${m ? MEASURE_TYPE_LABEL[m.type] : "?"}${m?.unit ? `・${m.unit}` : ""}）`;
                  }).join("、")}
            </p>
          </article>
        ))}
      </section>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        作成 {d.createdAt} {d.createdBy}／更新 {d.updatedAt} {d.updatedBy}
      </p>
    </>
  );
}

function ProcedureBody({ p }: { p: Procedure }) {
  if (p.kind === "ai-instruction") return <p className="whitespace-pre-wrap">{p.body}</p>;
  if (p.kind === "command")
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm">
        <dt className="text-slate-500">コマンド</dt>
        <dd className="font-mono break-all">{[p.command, ...p.args].join(" ")}</dd>
        <dt className="text-slate-500">作業場所</dt>
        <dd className="font-mono">{p.repo ? `${p.repo}:${p.cwd ?? "."}` : "決めない"}</dd>
      </dl>
    );
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm">
      <dt className="text-slate-500">ファイル</dt>
      <dd className="font-mono break-all">
        {p.repo}:{p.path}
      </dd>
      <dt className="text-slate-500">呼び出し方</dt>
      <dd className="font-mono break-all">{p.invoke ?? "決めない"}</dd>
    </dl>
  );
}
