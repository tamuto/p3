import { linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createDefinition } from "../../lib/api.ts";
import { DefinitionForm } from "../../components/DefinitionForm.tsx";

/** /observer/new: 観測の定義を登録する（保存すると詳細へ移る） */
export const Route = createFileRoute("/observer/new")({ component: NewDefinition });

function NewDefinition() {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-5 py-8">
      <Link to="/observer" className={linkCls}>
        ← 観測の一覧
      </Link>
      <h1 className="text-2xl font-bold">観測を登録</h1>
      <DefinitionForm submitLabel="登録する" onSave={createDefinition} onSaved={(d) => void navigate({ to: "/observer/$id", params: { id: d.id } })} />
    </div>
  );
}
