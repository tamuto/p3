import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Milestone, ProjectConfig } from "../../shared/types.ts";
import { ChatGptPanel } from "../components/ChatGptPanel.tsx";
import { ReposPanel } from "../components/ReposPanel.tsx";
import { ThemePanel } from "../components/ThemePanel.tsx";
import { Button, cx, Field, inputCls, Section } from "../components/ui.tsx";
import { api, ApiError } from "../lib/api.ts";
import { useAppCtx } from "../lib/appCtx.ts";
import { useUnsaved } from "../lib/unsaved.ts";
import { compareMilestoneIds } from "../../shared/milestoneOrder.ts";

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
  const [draft, setDraft] = useState<ProjectConfig>(ctx.info.project);
  const [dirty, setDirty] = useState(false);
  /** 編集を始めたときの設定（編集中に外で変わったかを見る） */
  const [base, setBase] = useState<ProjectConfig>(ctx.info.project);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /**
   * マイルストーンを出す順（draft.milestones の添字）。取り込んだときに ID のバージョンの降順にし、編集の間は変えない（ID を
   * 書き換えても行が動かない。足した行は最後）。保存する順（project.yaml）は draft.milestones のままで、表示のために並べ替えない
   */
  const [order, setOrder] = useState<number[]>(() => milestoneOrder(ctx.info.project.milestones));

  // 外部（CLI・エディタ）で変わったら、編集中でなければ取り込む。編集中は入力を残して知らせる
  useEffect(() => {
    if (dirty) return;
    setDraft(ctx.info.project);
    setBase(ctx.info.project);
    setOrder(milestoneOrder(ctx.info.project.milestones));
  }, [ctx.info.project, dirty]);
  const changedElsewhere = dirty && JSON.stringify(ctx.info.project) !== JSON.stringify(base);

  const set = <K extends keyof ProjectConfig>(k: K, v: ProjectConfig[K]) => {
    setDraft({ ...draft, [k]: v });
    setDirty(true);
    setMsg(null);
  };
  /** その列にあるタスクの数（全要望） */

  async function save() {
    try {
      await api.saveProject(draft);
      setDirty(false);
      setMsg({ ok: true, text: "保存しました" });
      ctx.reload();
    } catch (e) {
      const issues = e instanceof ApiError ? (e.body as { issues?: { message: string; path: (string | number)[] }[] }).issues : undefined;
      setMsg({ ok: false, text: issues ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ") : (e as Error).message });
    }
  }

  /** そのマイルストーンに入っている要望の数 */
  const inMilestone = (id: string) => ctx.requests.filter((p) => p.request.milestone === id).length;
  const updateMilestone = (i: number, patch: Partial<Milestone>) =>
    set("milestones", draft.milestones.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const removeMilestone = (i: number) => {
    set("milestones", draft.milestones.filter((_, j) => j !== i));
    setOrder(order.filter((j) => j !== i).map((j) => (j > i ? j - 1 : j)));
  };
  const addMilestone = () => {
    set("milestones", [...draft.milestones, { id: "", title: "" }]);
    setOrder([...order, draft.milestones.length]);
  };
  const unsaved: Record<SettingsTab, boolean> = { personal: false, project: dirty, repos: reposDirty };
  useUnsaved(dirty || reposDirty);
  return (
    // ブラウザの幅をそのまま使う（ほかの画面と同じ）。狭い画面では左右の余白を縮める
    <div className={cx("w-full space-y-6 px-4 pt-6 sm:px-6 lg:px-8 lg:pt-8", tab === "project" ? "pb-24" : "pb-10")}>
      <header className="space-y-4">
        <h1 className="text-2xl font-bold">設定</h1>
        <SettingsTabs tab={tab} unsaved={unsaved} onSelect={(t) => void navigate({ search: (prev) => ({ ...prev, tab: t }), replace: true })} />
      </header>

      <TabPanel id="personal" tab={tab}>
        <ChatGptPanel tick={ctx.tick} />
        <ThemePanel tick={ctx.tick} />
      </TabPanel>

      <TabPanel id="repos" tab={tab}>
        <ReposPanel tick={ctx.tick} onChanged={ctx.reload} onDirtyChange={setReposDirty} />
      </TabPanel>

      <TabPanel id="project" tab={tab}>
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

        <Section title="マイルストーン（リリース）">
          <p className="text-slate-500">複数の要望をまとめてリリースする単位です。要望の概要でマイルストーンを選ぶと、進捗画面でまとめて表示されます。</p>
          <div className="space-y-2">
            {order.map((i) => {
              const m = draft.milestones[i];
              return (
                <div key={i} className="flex items-center gap-2">
                  <input className={`${inputCls} !w-32 font-mono`} value={m.id} placeholder="v0.2" onChange={(e) => updateMilestone(i, { id: e.target.value })} />
                  <input className={inputCls} value={m.title} placeholder="名前" onChange={(e) => updateMilestone(i, { title: e.target.value })} />
                  <input type="date" className={`${inputCls} !w-44 shrink-0`} value={m.due ?? ""} onChange={(e) => updateMilestone(i, { due: e.target.value || undefined })} />
                  <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                    <input type="checkbox" checked={!!m.done} onChange={(e) => updateMilestone(i, { done: e.target.checked || undefined })} />
                    リリース済み
                  </label>
                  <span className="w-16 shrink-0 text-right text-sm text-slate-400">要望 {inMilestone(m.id)}</span>
                  <Button variant="ghost" disabled={inMilestone(m.id) > 0} onClick={() => removeMilestone(i)}>
                    削除
                  </Button>
                </div>
              );
            })}
            <Button onClick={addMilestone}>＋ マイルストーンを追加</Button>
          </div>
        </Section>

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
            <Button variant="ghost" disabled={!dirty} onClick={() => (setDraft(ctx.info.project), setOrder(milestoneOrder(ctx.info.project.milestones)), setDirty(false), setMsg(null))}>
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

const tabId = (id: SettingsTab) => `settings-tab-${id}`;
const panelId = (id: SettingsTab) => `settings-panel-${id}`;

/** タブの並び。矢印キー・Home・End で移る（選んだタブだけがフォーカスの順に入る） */
function SettingsTabs({ tab, unsaved, onSelect }: { tab: SettingsTab; unsaved: Record<SettingsTab, boolean>; onSelect: (t: SettingsTab) => void }) {
  const refs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const onKey = (e: KeyboardEvent) => {
    const i = SETTINGS_TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === "ArrowRight" ? (i + 1) % SETTINGS_TABS.length : e.key === "ArrowLeft" ? (i - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length : e.key === "Home" ? 0 : e.key === "End" ? SETTINGS_TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const id = SETTINGS_TABS[next].id;
    onSelect(id);
    refs.current[id]?.focus();
  };
  return (
    <div role="tablist" aria-label="設定の分類" className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800" onKeyDown={onKey}>
      {SETTINGS_TABS.map((t) => {
        const on = t.id === tab;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={tabId(t.id)}
            aria-selected={on}
            aria-controls={panelId(t.id)}
            tabIndex={on ? 0 : -1}
            title={t.hint}
            onClick={() => onSelect(t.id)}
            className={cx(
              "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 font-medium whitespace-nowrap transition",
              on
                ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            {t.label}
            {unsaved[t.id] && (
              <span className="text-xs text-amber-600 dark:text-amber-400" title="保存していない変更があります">
                ●<span className="sr-only">（未保存）</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** 選んでいないタブは隠すだけ（書きかけの入力を残す） */
function TabPanel({ id, tab, children }: { id: SettingsTab; tab: SettingsTab; children: ReactNode }) {
  return (
    <div role="tabpanel" id={panelId(id)} aria-labelledby={tabId(id)} hidden={id !== tab} className="space-y-10">
      {children}
    </div>
  );
}

/** マイルストーンの添字を ID のバージョンの降順に（shared/milestoneOrder.ts） */
function milestoneOrder(ms: readonly Milestone[]): number[] {
  return ms.map((_, i) => i).sort((a, b) => compareMilestoneIds(ms[a].id, ms[b].id));
}
