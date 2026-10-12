import { useEffect, useRef, useState } from "react";
import type { CodeMapEntry } from "../../shared/repos.ts";
import { api, type RepoInfo } from "../lib/api.ts";
import { latestOnly, STALE } from "../lib/latest.ts";
import { Badge, Button, cx, Field, inputCls, Section } from "./ui.tsx";

const STATUS: Record<RepoInfo["status"], { label: string; tone: "emerald" | "amber" | "rose" }> = {
  ok: { label: "読める", tone: "emerald" },
  unregistered: { label: "このマシンのパスが未登録", tone: "amber" },
  missing: { label: "パスが無い", tone: "rose" },
  notdir: { label: "フォルダでない", tone: "rose" },
};

/**
 * 参照先（Preflight が読むリポジトリ・フォルダ。作業先にできるものはタスクの作業先になる）。
 *   共有の定義（名前・役割・最初に読む・作業先にできる・主なフォルダ）は project.yaml の repos に書く（チームで共有）
 *   このマシンのパスは個人設定に書く（このマシンのローカルの画面からだけ見せ・変える）
 * CLI の p3 repo と同じ操作（server/repoAdmin.ts）。
 */
export function ReposPanel({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [data, setData] = useState<{ local: boolean; registered: boolean; repos: RepoInfo[] }>();
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(latestOnly());
  const load = () =>
    latest.current.run(() => api.repos()).then(
      (r) => r !== STALE && setData(r),
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  /** 操作して読み直す。失敗は知らせて入力は残す */
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      setError(null);
      await load();
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <Section title="参照先（リポジトリ・フォルダ）">
      <p className="text-sm text-slate-500">
        Preflight が読むリポジトリ・フォルダ。数と名前は自由で、git でなくてもよい。「作業先にできる」ものはタスクの作業先になる。
        名前・役割・主なフォルダはチームで共有し（project.yaml）、このマシンのパスは個人設定に置く（共有しない）。
      </p>
      {error && (
        <p role="alert" className="text-sm break-words text-rose-600">
          {error}
        </p>
      )}
      {data && !data.local && <p className="text-sm text-slate-500">このマシンのパスは、P3 を動かしているマシンの画面でだけ見られます。</p>}
      {data && data.local && !data.registered && (
        <p className="text-sm text-amber-700 dark:text-amber-300">このプロジェクトは個人設定に登録されていないので、このマシンのパスは登録できません（p3 project add）。</p>
      )}
      <ul className="space-y-3">
        {data?.repos.map((r) => (
          <RepoCard key={r.name} repo={r} local={data.local && data.registered} act={act} />
        ))}
      </ul>
      {data && <AddRepo local={data.local && data.registered} act={act} />}
    </Section>
  );
}

type Act = (f: () => Promise<unknown>) => Promise<boolean>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function RepoCard({ repo, local, act }: { repo: RepoInfo; local: boolean; act: Act }) {
  const saved = { role: repo.role, readFirst: repo.readFirst, writable: repo.writable, map: repo.map };
  const [draft, setDraft] = useState(saved);
  const [path, setPath] = useState(repo.local ?? "");
  const [confirm, setConfirm] = useState(false);
  // 取り直したら、編集していなければ追従する
  const savedKey = JSON.stringify(saved);
  const base = useRef(savedKey);
  useEffect(() => {
    if (same(draft, JSON.parse(base.current))) setDraft(JSON.parse(savedKey));
    base.current = savedKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);
  useEffect(() => setPath(repo.local ?? ""), [repo.local]);
  const dirty = !same(draft, saved);
  const setMap = (i: number, patch: Partial<CodeMapEntry>) => setDraft((d) => ({ ...d, map: d.map.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const st = STATUS[repo.status];

  return (
    <li className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-all">{repo.name}</span>
        <span className="font-mono text-sm text-slate-400">/workspace/{repo.mount}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="ml-auto flex gap-2">
          {confirm ? (
            <>
              <span className="text-sm text-rose-700 dark:text-rose-300">共有の定義を消します（ほかの人も読まなくなる。フォルダは消さない）</span>
              <Button variant="danger" onClick={() => void act(() => api.removeRepo(repo.name))}>
                消す
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                やめる
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              消す…
            </Button>
          )}
        </span>
      </div>
      <Field label="役割">
        <input className={inputCls} value={draft.role} placeholder="本体 / ドキュメント / 基盤 / 依存しているライブラリ" onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
      </Field>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.readFirst} onChange={(e) => setDraft({ ...draft, readFirst: e.target.checked })} />
          最初に読む
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.writable} onChange={(e) => setDraft({ ...draft, writable: e.target.checked })} />
          作業先にできる
        </label>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
          主なフォルダ <span className="font-normal text-slate-400">— Preflight がどこから読むかの案内。入口はそのフォルダで最初に読むファイル（参照先の中のパス）</span>
        </p>
        {draft.map.length > 0 && (
          <div className="hidden grid-cols-[repeat(3,minmax(0,1fr))_2.5rem] gap-2 text-sm text-slate-500 sm:grid dark:text-slate-400" aria-hidden>
            <span>フォルダ</span>
            <span>役割</span>
            <span>入口（任意）</span>
          </div>
        )}
        {draft.map.map((m, i) => (
          // 広い画面ではフォルダ・役割・入口を3等分する。狭い画面では縦に並べる
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_2.5rem] gap-2 sm:grid-cols-[repeat(3,minmax(0,1fr))_2.5rem]">
            <input className={cx(inputCls, "font-mono max-sm:col-span-2")} aria-label="フォルダ" placeholder="src/server" value={m.path} onChange={(e) => setMap(i, { path: e.target.value })} />
            <input className={cx(inputCls, "max-sm:col-span-2")} aria-label="役割" placeholder="API とデータ" value={m.role} onChange={(e) => setMap(i, { role: e.target.value })} />
            <input className={cx(inputCls, "font-mono")} aria-label="入口" placeholder="src/server/app.ts" value={m.entry ?? ""} onChange={(e) => setMap(i, { entry: e.target.value || undefined })} />
            <Button variant="ghost" aria-label={`主なフォルダ ${m.path || "の行"} を外す`} onClick={() => setDraft({ ...draft, map: draft.map.filter((_, j) => j !== i) })}>
              ×
            </Button>
          </div>
        ))}
        <Button variant="ghost" onClick={() => setDraft({ ...draft, map: [...draft.map, { path: "", role: "" }] })}>
          ＋ フォルダを足す
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!dirty} onClick={() => void act(() => api.updateRepo(repo.name, draft))}>
          保存
        </Button>
        <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(saved)}>
          元に戻す
        </Button>
        {dirty && <span className="text-sm text-slate-500">未保存の変更があります</span>}
      </div>
      {local && (
        <div className="flex flex-wrap items-start gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="min-w-0 flex-1 basis-64">
            <Field label="このマシンのパス" hint="個人設定に置き、共有しない">
              <input className={cx(inputCls, "font-mono")} value={path} placeholder="/home/me/src/..." onChange={(e) => setPath(e.target.value)} />
            </Field>
          </div>
          <Button className="mt-6" disabled={!path.trim() || path === repo.local} onClick={() => void act(() => api.setRepoPath(repo.name, path.trim()))}>
            登録
          </Button>
          {repo.local && (
            <Button variant="ghost" className="mt-6" onClick={() => void act(() => api.setRepoPath(repo.name, null))}>
              外す
            </Button>
          )}
          {repo.reason && repo.status !== "ok" && <p className="w-full text-sm break-words text-rose-600">{repo.reason}</p>}
        </div>
      )}
    </li>
  );
}

function AddRepo({ local, act }: { local: boolean; act: Act }) {
  const empty = { name: "", role: "", readFirst: false, writable: false, path: "" };
  const [f, setF] = useState(empty);
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-slate-300 p-4 dark:border-slate-700">
      <p className="text-sm font-medium text-slate-500 dark:text-slate-400">参照先を足す</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="名前" hint="空白・コロン・スラッシュは使えない">
          <input className={inputCls} value={f.name} placeholder="docs" onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="役割">
          <input className={inputCls} value={f.role} placeholder="ドキュメント" onChange={(e) => setF({ ...f, role: e.target.value })} />
        </Field>
        {local && (
          <Field label="このマシンのパス" hint="任意。あとで登録してもよい">
            <input className={cx(inputCls, "font-mono")} value={f.path} onChange={(e) => setF({ ...f, path: e.target.value })} />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.readFirst} onChange={(e) => setF({ ...f, readFirst: e.target.checked })} />
          最初に読む
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={f.writable} onChange={(e) => setF({ ...f, writable: e.target.checked })} />
          作業先にできる
        </label>
        <Button
          variant="primary"
          disabled={!f.name.trim()}
          onClick={async () => {
            const ok = await act(() =>
              api.addRepo({ name: f.name.trim(), role: f.role, readFirst: f.readFirst, writable: f.writable, ...(f.path.trim() ? { path: f.path.trim() } : {}) }),
            );
            if (ok) setF(empty);
          }}
        >
          足す
        </Button>
      </div>
    </div>
  );
}
