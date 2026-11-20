import { linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createPreparation } from "../../../lib/api.ts";
import { PreparationForm } from "../../../components/PreparationForm.tsx";

/** /observer/preparations/new: 準備を登録する（名前・説明・占有と、確かめ・前処理・後処理） */
export const Route = createFileRoute("/observer/preparations/new")({ component: NewPreparation });

function NewPreparation() {
  const navigate = useNavigate();
  return (
    <div className="w-full space-y-4 px-4 py-6 sm:px-6 lg:p-8">
      <Link to="/observer/preparations" className={linkCls}>
        ← 準備の一覧
      </Link>
      <h1 className="text-2xl font-bold">準備を登録</h1>
      <PreparationForm submitLabel="保存する" onSave={createPreparation} onSaved={(p) => void navigate({ to: "/observer/preparations/$pid", params: { pid: p.id } })} />
    </div>
  );
}
