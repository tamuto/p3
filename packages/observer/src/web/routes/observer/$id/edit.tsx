import { Alert, Button, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { fetchDefinition, fetchDraft, updateDefinition } from "../../../lib/api.ts";
import { useLoad } from "../../../lib/useLoad.ts";
import { DefinitionForm } from "../../../components/DefinitionForm.tsx";

/**
 * /observer/<ID>/edit: 観測の定義を直し、AI に提案を頼む。編集途中の入力は観測に残り、読み直しても戻る。
 * 確定の保存は開いたときの版を添える（ほかで更新されていれば断られ、入力は残る）。下書きが今の版より古いときは知らせ、選んだときだけ開く
 */
export const Route = createFileRoute("/observer/$id/edit")({ component: EditDefinition });

function EditDefinition() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const load = useLoad(async () => ({ ...(await fetchDefinition(id)), ...(await fetchDraft(id)) }), id);
  const [useOld, setUseOld] = useState(false);
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-5 py-8">
      <Link to="/observer/$id" params={{ id }} className={linkCls}>
        ← 詳細へ戻る
      </Link>
      <h1 className="text-2xl font-bold">観測を編集</h1>
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>観測の定義を読めませんでした: {load.message}</Alert>}
      {load.kind === "ok" && (() => {
        const { definition: d, draft } = load.value;
        const old = draft && draft.basedOnRev !== d.rev;
        return (
          <>
            <p className="text-slate-600 dark:text-slate-400">
              {id}・保存済みの版 v{d.rev}
            </p>
            {old && !useOld && (
              <Alert box warn>
                {`保存済みの定義（v${d.rev}）より古い版（v${draft.basedOnRev}）をもとにした編集途中の入力があります。`}{" "}
                <Button onClick={() => setUseOld(true)}>その入力を開く</Button>
              </Alert>
            )}
            <DefinitionForm
              key={useOld ? "draft" : "definition"}
              id={id}
              rev={d.rev}
              initial={d}
              saved={draft ?? undefined}
              restore={!!draft && (!old || useOld)}
              submitLabel="保存する"
              onSave={(input) => updateDefinition(id, d.rev, input)}
              onSaved={() => void navigate({ to: "/observer/$id", params: { id } })}
            />
          </>
        );
      })()}
    </div>
  );
}
