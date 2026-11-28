import { linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { KeyForm } from "../../components/KeyForm.tsx";
import { observerApi } from "../../lib/api.ts";

/** /observer/new: 項目キーを登録する（値は登録したあとで、外から・詳細の画面から足す） */
export const Route = createFileRoute("/observer/new")({ component: NewKey });

function NewKey() {
  const navigate = useNavigate();
  return (
    <div className="w-full space-y-4 px-4 py-6 sm:px-6 lg:p-8">
      <Link to="/observer" className={linkCls}>
        ← 観測の一覧
      </Link>
      <h1 className="text-2xl font-bold">観測の項目を登録</h1>
      <p className="text-fg-3">項目キーを先に決めて登録し、値を入れる側はそのキーを指定して値を送ります。何を実行してその値を得たかは、p3 では扱いません。</p>
      <KeyForm
        submitLabel="登録する"
        onSubmit={async (input) => {
          const k = await observerApi.createKey(input);
          void navigate({ to: "/observer/$key", params: { key: k.key } });
        }}
      />
    </div>
  );
}
