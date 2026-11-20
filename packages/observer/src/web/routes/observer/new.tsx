import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createDefinition, fetchDefinitions, type DefinitionTargetInfo } from "../../lib/api.ts";
import { DefinitionForm } from "../../components/DefinitionForm.tsx";
import { linkCls, TargetLine } from "../../components/Target.tsx";

/** /observer/new: 観測の定義を登録する（保存すると詳細へ移る） */
export const Route = createFileRoute("/observer/new")({ component: NewDefinition });

function NewDefinition() {
  const navigate = useNavigate();
  const [target, setTarget] = useState<DefinitionTargetInfo>();
  useEffect(() => {
    // 登録先を先に見せる（読めなくても入力はできる。保存のときに理由が出る）
    fetchDefinitions().then(
      (l) => setTarget(l.target),
      () => {},
    );
  }, []);
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-5 py-8">
      <Link to="/observer" className={linkCls}>
        ← 観測の一覧
      </Link>
      <h1 className="text-2xl font-bold">観測を登録</h1>
      <TargetLine target={target} />
      <DefinitionForm submitLabel="登録する" onSave={createDefinition} onSaved={(d) => void navigate({ to: "/observer/$id", params: { id: d.id } })} />
    </div>
  );
}
