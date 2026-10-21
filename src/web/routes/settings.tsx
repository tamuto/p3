import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ProjectConfig } from "../../shared/types.ts";
import { ChatGptPanel } from "../components/ChatGptPanel.tsx";
import { ReposPanel } from "../components/ReposPanel.tsx";
import { TabPanel, Tabs } from "../components/Tabs.tsx";
import { ThemePanel } from "../components/ThemePanel.tsx";
import { Button, cx, Field, inputCls, Section } from "../components/ui.tsx";
import { api, saveErrorText } from "../lib/api.ts";
import { useAppCtx } from "../lib/appCtx.ts";
import { useUnsaved } from "../lib/unsaved.ts";

/** 設定画面のタブ（1画面に1つの分類だけを出す）。選んだタブは URL（?tab=）に持つ */
export const SETTINGS_TABS = [
  { id: "personal", label: "個人", hint: "このマシン・この人。全プロジェクト共通" },
  { id: "project", label: "プロジェクトの基本", hint: "project.yaml。チームで共有" },
  { id: "repos", label: "参照先", hint: "リポジトリ・フォルダと、このマシンのパス" },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];
const isTab = (v: unknown): v is SettingsTab => SETTINGS_TABS.some((t) => t.id === v);

export const Route = createFileRoute("/settings")({
  validateSearch: (s: Record<string, unknown>): { tab?: SettingsTab } => ({ tab: isTab(s.tab) ? s.tab : undefined }),
  component: SettingsPage,
});

/**
 * プロジェクトの基本のタブで編集して保存する項目。保存はこれだけを送る（マイルストーンはリリースノートの画面、参照先は参照先のタブが
 * 別に保存するので、ここから送ると外での変更を巻き戻す）
 */
type BasicConfig = Pick<ProjectConfig, "name" | "description" | "preflight" | "branchPattern">;
const basicOf = (p: ProjectConfig): BasicConfig => ({ name: p.name, description: p.description, preflight: p.preflight, branchPattern: p.branchPattern });

/**
 * 設定画面。タブで「個人」（ChatGPT の接続・テーマ）、「プロジェクトの基本」（project.yaml。CLI の p3 config と同じ内容）、
 * 「参照先」（共有の定義とこのマシンのパス。CLI の p3 repo と同じ）に分ける。
 * 選んでいないタブも消さずに隠すだけにして、書きかけの入力を残す。保存していない変更があるタブには印を付ける。
 * project.yaml のコメントは保存しても残る。
 */
function SettingsPage() {
  const ctx = useAppCtx();
  const { tab = "personal" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [reposDirty, setReposDirty] = useState(false);
  const [draft, setDraft] = useState<BasicConfig>(() => basicOf(ctx.info.project));
  const [dirty, setDirty] = useState(false);
  /** 編集を始めたときの基本の項目（編集中に外で変わったかを見る。マイルストーン・参照先の変更は見ない） */
  const [base, setBase] = useState<BasicConfig>(() => basicOf(ctx.info.project));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 外部（CLI・エディタ）で変わったら、編集中でなければ取り込む。編集中は入力を残して知らせる
  useEffect(() => {
    if (dirty) return;
    setDraft(basicOf(ctx.info.project));
    setBase(basicOf(ctx.info.project));
  }, [ctx.info.project, dirty]);
  const changedElsewhere = dirty && JSON.stringify(basicOf(ctx.info.project)) !== JSON.stringify(base);

  const set = <K extends keyof BasicConfig>(k: K, v: BasicConfig[K]) => {
    setDraft({ ...draft, [k]: v });
    setDirty(true);
    setMsg(null);
  };
  async function save() {
    try {
      await api.saveProject(draft);
      setDirty(false);
      setMsg({ ok: true, text: "保存しました" });
      ctx.reload();
    } catch (e) {
      setMsg({ ok: false, text: saveErrorText(e) });
    }
  }

  const unsaved: Record<SettingsTab, boolean> = { personal: false, project: dirty, repos: reposDirty };
  useUnsaved(dirty || reposDirty);
  return (
    // ブラウザの幅をそのまま使う（ほかの画面と同じ）。狭い画面では左右の余白を縮める
    <div className={cx("w-full space-y-6 px-4 pt-6 sm:px-6 lg:px-8 lg:pt-8", tab === "project" ? "pb-24" : "pb-10")}>
      <header className="space-y-4">
        <h1 className="text-2xl font-bold">設定</h1>
        <Tabs tabs={SETTINGS_TABS} tab={tab} unsaved={unsaved} label="設定の分類" prefix="settings" onSelect={(t) => void navigate({ search: (prev) => ({ ...prev, tab: t }), replace: true })} />
      </header>

      <TabPanel id="personal" tab={tab} prefix="settings" className="space-y-10">
        <ChatGptPanel tick={ctx.tick} />
        <ThemePanel tick={ctx.tick} />
      </TabPanel>

      <TabPanel id="repos" tab={tab} prefix="settings" className="space-y-10">
        <ReposPanel tick={ctx.tick} onChanged={ctx.reload} onDirtyChange={setReposDirty} />
      </TabPanel>

      <TabPanel id="project" tab={tab} prefix="settings" className="space-y-10">
        <p className="min-w-0 truncate font-mono text-sm text-slate-400" title={`${ctx.info.dataDir}/project.yaml`}>
          {ctx.info.dataDir}/project.yaml
        </p>

        <Section title="基本">
          <div className="space-y-3">
            <Field label="プロジェクト名">
              <input className={inputCls} value={draft.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="プロジェクトの説明" hint="何を作っているか。Preflight の前提になる">
              <textarea rows={3} className={inputCls} value={draft.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
          </div>
        </Section>

        <p className="text-slate-500 dark:text-slate-400">
          マイルストーン（リリース）は、
          <Link to="/release-notes" search={{ tab: "milestones" }} className="underline">
            リリースノートの「マイルストーン」タブ
          </Link>
          で追加・変更します。
        </p>

        <Section title="Preflight">
          <Field label="評価の観点・制約" hint="Codex への指示に加わる">
            <textarea
              rows={4}
              className={inputCls}
              placeholder="例: 外部 SaaS の追加は要相談。個人情報を扱う変更は必ずリスクに挙げる。"
              value={draft.preflight.instructions}
              onChange={(e) => set("preflight", { instructions: e.target.value })}
            />
          </Field>
        </Section>

        <Section title="ブランチ">
          <Field label="ブランチ名" hint="{id} {slug} を置換する。作業先のリポジトリごとに同じ名前で割り当てる">
            <input className={`${inputCls} font-mono`} value={draft.branchPattern} onChange={(e) => set("branchPattern", e.target.value)} />
          </Field>
        </Section>

      </TabPanel>

      {tab === "project" && (
        <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
          <div className="flex w-full flex-wrap items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
              保存
            </Button>
            <Button variant="ghost" disabled={!dirty} onClick={() => (setDraft(basicOf(ctx.info.project)), setDirty(false), setMsg(null))}>
              元に戻す
            </Button>
            {msg && <span className={cx(msg.ok ? "text-emerald-600" : "text-rose-600")}>{msg.text}</span>}
            {dirty && !msg && !changedElsewhere && <span className="text-slate-500">未保存の変更があります</span>}
            {changedElsewhere && !msg && (
              <span role="status" className="text-amber-700 dark:text-amber-300">
                編集中に設定が他で変わりました。保存するとこの画面の内容で上書きします（最新を見るには「元に戻す」）
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
