import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { REQUEST_STATUSES, type RequestStatus, type Request } from "../../../shared/types.ts";
import { REQUEST_STATUS_LABEL } from "../RequestStatus.tsx";
import { Button, buttonCls, Field, inputCls } from "../ui.tsx";
import { api, failureOf } from "../../lib/api.ts";
import { type AppCtx } from "../../lib/appCtx.ts";
import { type RequestData } from "../../lib/requestData.tsx";
import { RequestIdCopy } from "../RequestIdCopy.tsx";
import { TagInput } from "../TagInput.tsx";
import { requestWorkstreams } from "../../../shared/workTarget.ts";
import { sameTags } from "../../../shared/tags.ts";
import { discardDraft, draftOf, editDraft } from "../../lib/draft.ts";
import { ExternalChange } from "./ExternalChange.tsx";
import { type RequestDrafts } from "../../lib/requestDrafts.ts";

/** 要望の管理情報（ID・タイトル・ステータス・期限・マイルストーン・タグ・ブランチ） */

/** 要望の管理情報（ID・タイトル・ステータス・期限・マイルストーン・タグ）。変えるとすぐ保存する。期限〜タグは Preflight には渡さない */
export function RequestMeta({ ctx, data, drafts }: { ctx: AppCtx; data: RequestData; drafts: RequestDrafts }) {
  const { request } = data;
  // タイトル・タグの入力は下書きで持つ（取り直しても編集中は上書きしない。保存は編集を始めたときの rev で）。本文と一緒に親が持つ
  const { titleD, setTitleD, tagsD, setTagsD } = drafts;
  const [tagsBusy, setTagsBusy] = useState(false);
  /** タグの入力欄の、まだ足していない文字（取り直しても残す） */
  const [tagText, setTagText] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save(
    patch: { title?: string; status?: RequestStatus; due?: string | null; milestone?: string | null; tags?: string[] },
    rev = request.rev,
  ): Promise<Request | null> {
    if (data.gone) {
      setError("この要望は見つからないので保存しません");
      return null;
    }
    try {
      const saved = await api.patchRequest(request.id, { ...patch, rev } as never);
      setError(null);
      data.reload();
      ctx.reload();
      return saved;
    } catch (e) {
      if (failureOf(e) === "rev_conflict") {
        setError("競合: 他で更新されています。入力は残してあります（最新を見るには「入力を捨てて最新にする」）");
        data.reload();
      } else setError((e as Error).message);
      return null;
    }
  }

  async function commitTitle() {
    const v = titleD.value.trim();
    if (!v || v === titleD.base) return setTitleD((d) => ({ ...d, value: d.base }));
    const saved = await save({ title: v }, titleD.baseRev);
    if (saved) setTitleD(draftOf(saved.title, saved.rev));
  }

  /** タグは足す・外すたびに保存する（編集を始めたときの rev で。保存中は次の操作を待たせる） */
  async function changeTags(next: string[]) {
    setTagsD((d) => editDraft(d, next));
    setTagsBusy(true);
    const saved = await save({ tags: next }, tagsD.baseRev);
    if (saved) setTagsD(draftOf(saved.tags, saved.rev));
    setTagsBusy(false);
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <RequestIdCopy id={request.id} />
        <Field label="タイトル">
          <input
            className={`${inputCls} text-lg font-semibold`}
            value={titleD.value}
            onChange={(e) => setTitleD((d) => editDraft(d, e.target.value))}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </Field>
        <ExternalChange label="タイトル" draft={titleD} onDiscard={() => (setTitleD((d) => discardDraft(d)), setError(null))} />
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <Field label="ステータス">
          <select className={`${inputCls} !w-36`} value={request.status} onChange={(e) => void save({ status: e.target.value as RequestStatus })}>
            {REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {REQUEST_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="期限">
          <input type="date" className={`${inputCls} !w-44`} value={request.due ?? ""} onChange={(e) => void save({ due: e.target.value || null })} />
        </Field>
        <Field label="マイルストーン">
          <select className={`${inputCls} !w-56`} value={request.milestone ?? ""} onChange={(e) => void save({ milestone: e.target.value || null })}>
            <option value="">（なし）</option>
            {ctx.info.project.milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
                {m.due ? `（${m.due}）` : ""}
              </option>
            ))}
          </select>
        </Field>
        {ctx.info.project.milestones.length === 0 && (
          <Link to="/settings" search={{ tab: "project" }} className={buttonCls("ghost", "mt-7 text-sm underline")}>
            マイルストーンを設定で作る
          </Link>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="request-tags" className="text-sm font-medium text-slate-500 dark:text-slate-400">
          タグ（外部 ID や分類。値ごとに Enter で足し、× で外す。すぐ保存）
        </label>
        <TagInput id="request-tags" tags={tagsD.value} onChange={(next) => void changeTags(next)} disabled={tagsBusy || data.gone} text={tagText} onText={setTagText} />
      </div>
      <Branches request={request} />
      <ExternalChange
        label="タグ"
        draft={tagsD}
        eq={sameTags}
        show={(v) => (v.length ? v.join("、") : "なし")}
        onDiscard={() => (setTagsD((d) => discardDraft(d)), setError(null))}
      />
      {data.issue && (
        <p className="flex flex-wrap items-center gap-3 rounded-md bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {data.issue}
          <Button onClick={() => void save({ status: "active" })}>進行中に戻す</Button>
        </p>
      )}
      {request.status === "resolved" && !data.issue && (
        <p className="text-sm text-sky-700 dark:text-sky-300">
          作業は全部終わっています。成果物を確かめたら、ステータスを「完了済」にしてください。
        </p>
      )}
      {error && <p className="text-rose-600">{error}</p>}
    </section>
  );
}

/** 作業先のリポジトリごとのブランチ（タスク化・作業先を足したときに割り当てた名前。git のブランチや作業ツリーは作業する人・AI が作る） */
function Branches({ request }: { request: Request }) {
  const branches = Object.entries(requestWorkstreams(request));
  if (!branches.length) return null;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-slate-500 dark:text-slate-400">ブランチ（作業先ごと）</p>
      <ul className="space-y-0.5 text-sm">
        {branches.map(([name, w]) => (
          <li key={name} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium break-all">{name}</span>
            <code className="font-mono break-all text-slate-600 dark:text-slate-300">{w.branch}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

