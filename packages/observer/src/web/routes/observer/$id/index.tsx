import { Alert, Button, buttonCls, Empty, Field, inputCls, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { filesOf, fileKey, MEASURE_TYPE_LABEL, type ObservationDefinition, type References, HISTORY_LABEL, type Drift, DRIFT_LABEL, driftText } from "../../../../shared/definition.ts";
import { endDefinition, fetchDefinition, switchProcedure } from "../../../lib/api.ts";
import { useFileStates } from "../../../lib/files.ts";
import { useLoad } from "../../../lib/useLoad.ts";
import { ProcedureView } from "../../../components/ProcedureView.tsx";
import { SwitchForm } from "../../../components/SwitchForm.tsx";
import { ResultsSection } from "../../../components/Results.tsx";

/**
 * /observer/<ID>: 観測の定義の詳細。観測内容・測定項目・確認の手順（今の実行方法・置き換え候補・ファイルの有無・切り替えの履歴）・結果（実行を記録する）。
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
      {load.kind === "ok" && <Detail d={load.value.definition} refs={load.value.references} drift={load.value.drift} reload={() => setTick((t) => t + 1)} />}
    </div>
  );
}

function Detail({ d, refs, drift, reload }: { d: ObservationDefinition; refs: References; drift: Drift; reload: () => void }) {
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
        {!d.ended && (
          <Link to="/observer/$id/edit" params={{ id: d.id }} className={buttonCls("primary")}>
            編集・AI に提案を頼む
          </Link>
        )}
      </header>
      {d.ended && (
        <Alert box warn>
          この観測は終了しています（{new Date(d.ended.at).toLocaleString()} {d.ended.by}）: {d.ended.reason}
          {d.ended.movedTo ? `。機械的な判定を移した先: ${d.ended.movedTo}` : ""}
        </Alert>
      )}
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
        {drift.state === "changed" ? <Alert box warn>{driftText(drift)}</Alert> : <p className="text-slate-600 dark:text-slate-400">{driftText(drift)}</p>}
        {drift.files.length > 0 && (
          <ul aria-label="期待を確定した後の参照ファイルの変化" className="list-disc space-y-1 pl-6">
            {drift.files.map((f) => (
              <li key={`${f.repo}:${f.path}`}>
                <code className="break-all">
                  {f.repo}:{f.path}
                </code>
                　{DRIFT_LABEL[f.change]}
              </li>
            ))}
          </ul>
        )}
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
      <ResultsSection id={d.id} rev={d.rev} ended={!!d.ended} />
      <section aria-labelledby="history-heading" className="space-y-2">
        <h2 id="history-heading" className="text-xl font-semibold">
          期待の履歴
        </h2>
        {!d.history?.length ? (
          <Empty>まだありません（この版より前に作った観測には履歴がありません）。</Empty>
        ) : (
          <ol className="list-decimal space-y-1 pl-6">
            {d.history.map((h, i) => (
              <li key={i}>
                {new Date(h.at).toLocaleString()} {HISTORY_LABEL[h.kind] ?? h.kind}（{h.by}
                {h.work ? `・${h.work.request}/${h.work.task} の作業` : ""}）{h.reason ? `: ${h.reason}` : ""}
                {h.kind === "expected" && <span className="block">「{h.before ?? "（未記入）"}」→「{h.expected ?? "（未記入）"}」</span>}
                {h.kind === "created" && h.expected && <span className="block">期待: {h.expected}</span>}
                {h.movedTo && <span className="block">移した先: {h.movedTo}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
      {!d.ended && <EndForm d={d} onDone={reload} />}
      <p className="text-slate-600 dark:text-slate-400" data-aux>
        作成 {new Date(d.createdAt).toLocaleString()} {d.createdBy}／更新 {new Date(d.updatedAt).toLocaleString()} {d.updatedBy}
      </p>
    </>
  );
}

/** 観測を終える（理由が要る。機械的な判定を外部の CI に移したなら移した先。今の版を添える。前提として使われていれば断られる） */
function EndForm({ d, onDone }: { d: ObservationDefinition; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [movedTo, setMovedTo] = useState("");
  const [error, setError] = useState<string>();
  if (!open)
    return (
      <div>
        <Button onClick={() => setOpen(true)}>観測を終える</Button>
      </div>
    );
  return (
    <form
      className="space-y-3"
      aria-label="観測を終える"
      onSubmit={(e) => {
        e.preventDefault();
        endDefinition(d.id, d.rev, reason, movedTo).then(onDone, (x: Error) => setError(x.message));
      }}
    >
      {error && <Alert box>{error}</Alert>}
      <Field label="終える理由">
        <textarea className={inputCls} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Field label="移した先（任意）" hint="毎回同じ動作で機械的に判定できるようになり、外部の CI に移したときのジョブ名や URL">
        <input className={inputCls} value={movedTo} onChange={(e) => setMovedTo(e.target.value)} />
      </Field>
      <div className="flex gap-3">
        <Button type="submit" variant="primary">
          終える
        </Button>
        <Button variant="cancel" onClick={() => setOpen(false)}>
          やめる
        </Button>
      </div>
    </form>
  );
}
