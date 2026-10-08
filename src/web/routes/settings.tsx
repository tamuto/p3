import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Member, ProjectConfig, StatusDef } from "../../shared/types.ts";
import { Button, cx, Field, inputCls, Section } from "../components/ui.tsx";
import { api, ApiError } from "../lib/api.ts";
import { useAppCtx } from "../lib/appCtx.ts";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

/**
 * プロジェクト設定（project.yaml）の編集。CLI の pcube config / pcube member と同じ内容。
 * ファイルのコメントは保存しても残る。
 */
function SettingsPage() {
  const ctx = useAppCtx();
  const [draft, setDraft] = useState<ProjectConfig>(ctx.info.project);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 外部（CLI・エディタ）で変わったら、編集中でなければ取り込む
  useEffect(() => {
    if (!dirty) setDraft(ctx.info.project);
  }, [ctx.info.project, dirty]);

  const set = <K extends keyof ProjectConfig>(k: K, v: ProjectConfig[K]) => {
    setDraft({ ...draft, [k]: v });
    setDirty(true);
    setMsg(null);
  };
  const assigned = (id: string) => ctx.tasks.filter((t) => t.assignee === id).length;
  const used = (id: string) => ctx.tasks.filter((t) => t.status === id).length;

  async function save() {
    try {
      await api.saveProject({ ...draft, docs: draft.docs.filter(Boolean) });
      setDirty(false);
      setMsg({ ok: true, text: "保存しました" });
      ctx.reload();
    } catch (e) {
      const issues = e instanceof ApiError ? (e.body as { issues?: { message: string; path: (string | number)[] }[] }).issues : undefined;
      setMsg({ ok: false, text: issues ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ") : (e as Error).message });
    }
  }

  const updateMember = (i: number, patch: Partial<Member>) =>
    set("members", draft.members.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const updateStatus = (i: number, patch: Partial<StatusDef>) =>
    set("statuses", draft.statuses.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const moveStatus = (i: number, d: -1 | 1) => {
    const list = [...draft.statuses];
    [list[i], list[i + d]] = [list[i + d], list[i]];
    set("statuses", list);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-10 p-8 pb-24">
      <header className="flex items-center gap-4">
        <h1 className="shrink-0 text-2xl font-bold">プロジェクト設定</h1>
        <span className="min-w-0 truncate font-mono text-sm text-slate-400" title={`${ctx.info.dataDir}/project.yaml`}>{ctx.info.dataDir}/project.yaml</span>
      </header>

      <Section title="基本">
        <div className="space-y-3">
          <Field label="プロジェクト名">
            <input className={inputCls} value={draft.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="何を作っているプロジェクトか（Preflight の前提になります）">
            <textarea rows={3} className={inputCls} value={draft.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </div>
      </Section>

      <Section title="ドキュメント">
        <p className="text-slate-500">リポジトリ内のファイル/フォルダ。Preflight で Codex が最初に読みます（複製はせず、その場で読みます）。</p>
        <div className="space-y-2">
          {draft.docs.map((d, i) => (
            <div key={i} className="flex gap-2">
              <input
                className={`${inputCls} font-mono`}
                value={d}
                placeholder="docs/ や README.md"
                onChange={(e) => set("docs", draft.docs.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <Button variant="ghost" onClick={() => set("docs", draft.docs.filter((_, j) => j !== i))}>
                削除
              </Button>
            </div>
          ))}
          <Button onClick={() => set("docs", [...draft.docs, ""])}>＋ パスを追加</Button>
        </div>
      </Section>

      <Section title="メンバー">
        <p className="text-slate-500">
          担当者の候補になります。メールが git の user.email と一致すると、CLI での変更者が自動でそのメンバーになります。
        </p>
        <div className="overflow-hidden rounded-lg ring-1 ring-slate-200 dark:ring-slate-800">
          <table className="w-full">
            <thead className="bg-slate-50 text-left text-sm text-slate-500 dark:bg-slate-900">
              <tr>
                <th className="px-3 py-2 font-medium">id</th>
                <th className="px-3 py-2 font-medium">表示名</th>
                <th className="px-3 py-2 font-medium">メール</th>
                <th className="px-3 py-2 font-medium">役割</th>
                <th className="px-3 py-2 font-medium">AI</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-slate-950">
              {draft.members.map((m, i) => (
                <tr key={i}>
                  <td className="px-2 py-1.5">
                    <input className={`${inputCls} font-mono`} value={m.id} onChange={(e) => updateMember(i, { id: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <input className={inputCls} value={m.name} onChange={(e) => updateMember(i, { name: e.target.value })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <input className={inputCls} value={m.email ?? ""} onChange={(e) => updateMember(i, { email: e.target.value || undefined })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <input className={inputCls} value={m.role ?? ""} placeholder="owner など" onChange={(e) => updateMember(i, { role: e.target.value || undefined })} />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <input type="checkbox" checked={m.kind === "ai"} onChange={(e) => updateMember(i, { kind: e.target.checked ? "ai" : "human" })} />
                  </td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                    <span className="mr-2 text-sm text-slate-400">担当 {assigned(m.id)}</span>
                    <Button variant="ghost" onClick={() => set("members", draft.members.filter((_, j) => j !== i))}>
                      削除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button onClick={() => set("members", [...draft.members, { id: "", name: "", kind: "human" }])}>＋ メンバーを追加</Button>
      </Section>

      <Section title="かんばんの列（ステータス）">
        <p className="text-slate-500">id はタスクファイルの status に書かれる値です。使用中の列は消せません。</p>
        <div className="space-y-2">
          {draft.statuses.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={`${inputCls} !w-44 font-mono`} value={s.id} onChange={(e) => updateStatus(i, { id: e.target.value })} />
              <input className={inputCls} value={s.label} onChange={(e) => updateStatus(i, { label: e.target.value })} />
              <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                <input type="checkbox" checked={!!s.done} onChange={(e) => updateStatus(i, { done: e.target.checked })} />
                完了扱い
              </label>
              <span className="w-16 shrink-0 text-right text-sm text-slate-400">{used(s.id)} 件</span>
              <Button variant="ghost" disabled={i === 0} onClick={() => moveStatus(i, -1)}>
                ↑
              </Button>
              <Button variant="ghost" disabled={i === draft.statuses.length - 1} onClick={() => moveStatus(i, 1)}>
                ↓
              </Button>
              <Button variant="ghost" disabled={used(s.id) > 0} onClick={() => set("statuses", draft.statuses.filter((_, j) => j !== i))}>
                削除
              </Button>
            </div>
          ))}
          <Button onClick={() => set("statuses", [...draft.statuses, { id: "", label: "" }])}>＋ 列を追加</Button>
        </div>
      </Section>

      <Section title="Preflight">
        <Field label="評価で重視する観点・制約（Codex への指示に加わります）">
          <textarea
            rows={4}
            className={inputCls}
            placeholder="例: 外部 SaaS の追加は要相談。個人情報を扱う変更は必ずリスクに挙げる。"
            value={draft.preflight.instructions}
            onChange={(e) => set("preflight", { instructions: e.target.value })}
          />
        </Field>
      </Section>

      <Section title="作業ツリー">
        <div className="grid grid-cols-2 gap-3">
          <Field label="ブランチ名（{id} {slug} を置換）">
            <input className={`${inputCls} font-mono`} value={draft.branchPattern} onChange={(e) => set("branchPattern", e.target.value)} />
          </Field>
          <Field label="作業ツリーの置き場所（リポジトリ相対）">
            <input className={`${inputCls} font-mono`} value={draft.worktreeDir} onChange={(e) => set("worktreeDir", e.target.value)} />
          </Field>
        </div>
      </Section>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-8 py-3">
          <Button variant="primary" disabled={!dirty} onClick={save}>
            保存
          </Button>
          <Button variant="ghost" disabled={!dirty} onClick={() => (setDraft(ctx.info.project), setDirty(false), setMsg(null))}>
            元に戻す
          </Button>
          {msg && <span className={cx(msg.ok ? "text-emerald-600" : "text-rose-600")}>{msg.text}</span>}
          {dirty && !msg && <span className="text-slate-500">未保存の変更があります</span>}
        </div>
      </div>
    </div>
  );
}
