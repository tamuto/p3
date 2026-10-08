import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Field, inputCls } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { useAppCtx } from "../../lib/appCtx.ts";

export const Route = createFileRoute("/requests/new")({
  component: NewRequest,
});

function NewRequest() {
  const ctx = useAppCtx();
  const navigate = useNavigate();
  const onCreated = (id: string) => {
    ctx.reload();
    void navigate({ to: "/requests/$requestId", params: { requestId: id } });
  };
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [areas, setAreas] = useState("");
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-8">
      <h2 className="text-xl font-bold">新しい要望</h2>
      <p className="text-slate-500">要望はプロジェクトで行う作業の単位です。要望ごとにフォルダが作られ、Preflight で生まれたタスクはすべてその中に置かれます。</p>
      <Field label="タイトル">
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="内容（背景・やりたいこと・完了条件。箇条書きはタスク案の手がかりになります）">
        <textarea rows={12} className={`${inputCls} font-mono`} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <Field label="影響しそうな領域（任意・カンマ区切り。例: src/server/api, auth）">
        <input className={`${inputCls} font-mono`} value={areas} onChange={(e) => setAreas(e.target.value)} />
      </Field>
      <Button
        variant="primary"
        disabled={!title.trim()}
        onClick={async () => {
          const r = await api.createRequest({ title, body, areas: areas.split(",").map((s) => s.trim()).filter(Boolean) });
          onCreated(r.id);
        }}
      >
        作成
      </Button>
    </div>
  );
}
