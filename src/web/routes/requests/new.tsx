import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { NewAttachments } from "../../components/Attachments.tsx";
import { TagInput } from "../../components/TagInput.tsx";
import { Button, Field, inputCls } from "../../components/ui.tsx";
import { addTag } from "../../../shared/tags.ts";
import { api } from "../../lib/api.ts";
import { useUnsaved } from "../../lib/unsaved.ts";
import { useAppCtx } from "../../lib/appCtx.ts";
import { sortMilestones } from "../../../shared/milestoneOrder.ts";
import { parentChoices } from "../../lib/progressTree.ts";
import { checkPending, sendPending, setUnsentAttachments, type PendingAttach } from "../../lib/uiMaterials.ts";

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
  const [due, setDue] = useState("");
  const [milestone, setMilestone] = useState("");
  /** 親の要望（子として作る。省いた期限・マイルストーン・タグは親から写す） */
  const [parent, setParent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  /** タグの入力欄の、まだ足していない文字（作成するときに足す） */
  const [tagText, setTagText] = useState("");
  const [files, setFiles] = useState<PendingAttach[]>([]);
  /** 作成中（"作成中…" / "添付中 1/3"） */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = checkPending(files.map((f) => f.file));
  const blocked = !!check.total || check.items.some(Boolean);
  useUnsaved(!!(title.trim() || body.trim() || areas.trim() || due || milestone || parent || tags.length || tagText.trim() || files.length));
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  async function create() {
    setBusy("作成中…");
    setError(null);
    let id: string;
    try {
      ({ id } = await api.createRequest({ title, body, areas: list(areas), due: due || undefined, milestone: milestone || undefined, tags: [...addTag(tags, tagText)], parent: parent || undefined }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
      return;
    }
    // 要望はできた。添付の失敗は要望の画面で知らせて付け直す（ここに残ると作成を繰り返してしまう）
    if (files.length) {
      const failed = await sendPending(files, (f) => api.addAttachment(id, f), (n) => setBusy(`添付中 ${n}/${files.length}`));
      setUnsentAttachments(id, failed);
    }
    onCreated(id);
  }

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
      {/* 管理のための情報。Preflight（AI）には渡さない */}
      <div className="flex flex-wrap items-start gap-4">
        <Field label="期限（任意）">
          <input type="date" className={`${inputCls} !w-44`} value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <Field label="マイルストーン（任意）">
          <select className={`${inputCls} !w-56`} value={milestone} onChange={(e) => setMilestone(e.target.value)}>
            <option value="">（なし）</option>
            {sortMilestones(ctx.info.project.milestones).map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
                {m.due ? `（${m.due}）` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="親の要望（任意。子として作る）" hint={parent ? "期限・マイルストーン・タグを空にすると、親の値を写します（その後は別々）" : undefined}>
          <select className={`${inputCls} !w-auto max-w-full min-w-0 sm:min-w-72`} value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">（なし）</option>
            {parentChoices(ctx.requests.map((p) => p.request)).map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}（{r.id}）
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="new-request-tags" className="text-sm font-medium text-slate-500 dark:text-slate-400">
          タグ（任意。外部 ID や分類。値ごとに Enter で足す）
        </label>
        <TagInput id="new-request-tags" tags={tags} onChange={setTags} text={tagText} onText={setTagText} />
      </div>
      <NewAttachments items={files} onChange={setFiles} check={check} disabled={!!busy} />
      {error && <p className="text-rose-600">{error}</p>}
      <Button
        variant="primary"
        disabled={!title.trim() || blocked || !!busy}
        onClick={() => void create()}
      >
        {busy ?? (files.length ? `作成して ${files.length} 件を添付` : "作成")}
      </Button>
    </div>
  );
}
