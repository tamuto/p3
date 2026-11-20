import { Alert, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { fetchDefinition, updateDefinition } from "../../../lib/api.ts";
import { useLoad } from "../../../lib/useLoad.ts";
import { DefinitionForm } from "../../../components/DefinitionForm.tsx";

/** /observer/<ID>/edit: 観測の定義を直す（開いたときの版を添えて保存する。ほかで更新されていれば断られ、入力は残る） */
export const Route = createFileRoute("/observer/$id/edit")({ component: EditDefinition });

function EditDefinition() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const load = useLoad(() => fetchDefinition(id), id);
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-5 py-8">
      <Link to="/observer/$id" params={{ id }} className={linkCls}>
        ← 詳細へ戻る
      </Link>
      <h1 className="text-2xl font-bold">観測を編集</h1>
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>観測の定義を読めませんでした: {load.message}</Alert>}
      {load.kind === "ok" && (
        <>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {id}・開いたときの版 {load.value.definition.rev}
          </p>
          <DefinitionForm
            initial={load.value.definition}
            submitLabel="保存する"
            onSave={(input) => updateDefinition(id, load.value.definition.rev, input)}
            onSaved={() => void navigate({ to: "/observer/$id", params: { id } })}
          />
        </>
      )}
    </div>
  );
}
