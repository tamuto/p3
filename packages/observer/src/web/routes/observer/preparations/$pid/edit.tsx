import { Alert, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { fetchPreparation, updatePreparation } from "../../../../lib/api.ts";
import { useLoad } from "../../../../lib/useLoad.ts";
import { PreparationForm } from "../../../../components/PreparationForm.tsx";

/** /observer/preparations/<ID>/edit: 準備を直す（開いたときの版を添える。ほかで更新されていれば断られ、入力は残る） */
export const Route = createFileRoute("/observer/preparations/$pid/edit")({ component: EditPreparation });

function EditPreparation() {
  const { pid } = Route.useParams();
  const navigate = useNavigate();
  const load = useLoad(() => fetchPreparation(pid), pid);
  return (
    <div className="w-full space-y-4 px-4 py-6 sm:px-6 lg:p-8">
      <Link to="/observer/preparations/$pid" params={{ pid }} className={linkCls}>
        ← 詳細へ戻る
      </Link>
      <h1 className="text-2xl font-bold">準備を編集</h1>
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>準備を読めませんでした: {load.message}</Alert>}
      {load.kind === "ok" && (
        <>
          <p className="text-slate-600 dark:text-slate-400">
            {pid}・保存済みの版 v{load.value.preparation.rev}
          </p>
          <PreparationForm
            initial={load.value.preparation}
            submitLabel="保存する"
            onSave={(input) => updatePreparation(pid, load.value.preparation.rev, input)}
            onSaved={() => void navigate({ to: "/observer/preparations/$pid", params: { pid } })}
          />
        </>
      )}
    </div>
  );
}
