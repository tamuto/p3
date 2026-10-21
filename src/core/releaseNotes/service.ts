import type { ReleaseGeneration, ReleaseMaterial, ReleaseNote, ReleaseNoteSummary, ReleaseWarning } from "../../shared/types.ts";
import type { P3Context } from "../context.ts";
import { extractMaterial } from "./material.ts";
import type { SummaryEngine } from "./generate.ts";
import { checkMilestoneId, ReleaseNoteError } from "./store.ts";
import { compareMilestoneIds, sortMilestones } from "../../shared/milestoneOrder.ts";

/**
 * リリースノートの操作（CLI と API はここを呼ぶ）。材料の規則は material.ts、保存の形は store.ts。
 *
 * ノートを作る・変えるのは明示的に保存したときだけ。要望・タスク・マイルストーンの状態は変えない。
 * 保存では、そのときディスクにある材料を出典として固定する（本文の元にした材料が古ければ material_changed で知らせる）。
 */

/** マイルストーンごとのノートの有無。並びは登録したマイルストーンを ID のバージョンの降順（shared/milestoneOrder.ts）、その後ろに project.yaml に無いノート（同じ降順） */
export async function releaseOverview(ctx: P3Context): Promise<{ milestones: ReleaseNoteSummary[]; warnings: ReleaseWarning[] }> {
  const { ws } = ctx;
  const count = (mid: string) => ws.requests.list().filter((r) => r.milestone === mid).length;
  const ids = await ws.releaseNotes.ids();
  const noteState = async (mid: string): Promise<ReleaseNoteSummary["note"]> => {
    if (!ids.includes(mid)) return { state: "none" };
    try {
      const n = await ws.releaseNotes.read(mid);
      return { state: "ok", version: n.version, updatedAt: n.updatedAt, updatedBy: n.updatedBy };
    } catch (e) {
      if (e instanceof ReleaseNoteError && e.code === "not_found") return { state: "none" };
      return { state: "invalid", error: (e as Error).message };
    }
  };
  const known = sortMilestones(ws.project.milestones);
  const orphans = ids.filter((id) => !known.some((m) => m.id === id)).sort(compareMilestoneIds);
  const milestones: ReleaseNoteSummary[] = [
    ...(await Promise.all(known.map(async (m) => ({ milestone: m.id, title: m.title, due: m.due, done: m.done, known: true, requests: count(m.id), note: await noteState(m.id) })))),
    ...(await Promise.all(orphans.map(async (id) => ({ milestone: id, title: id, known: false, requests: count(id), note: await noteState(id) })))),
  ];
  const warnings: ReleaseWarning[] = orphans.map((id) => ({
    code: "unknown_milestone",
    target: id,
    message: `リリースノート ${id} のマイルストーンが project.yaml にありません（読めます。マイルストーンを足し直すか、不要ならファイルを消してください）`,
  }));
  return { milestones, warnings };
}

/** 材料。project.yaml に無く、ノートも無いマイルストーンは not_found */
export async function releaseMaterial(ctx: P3Context, mid: string): Promise<ReleaseMaterial> {
  checkMilestoneId(mid);
  const material = await extractMaterial(ctx.ws.dataDir, mid);
  if (!material.milestone.known && !(await ctx.ws.releaseNotes.ids()).includes(mid)) {
    throw new ReleaseNoteError("not_found", mid, `マイルストーンがありません: ${mid}`);
  }
  return material;
}

export interface ReleaseNoteDetail {
  /** 保存したノート（無ければ null） */
  note: ReleaseNote | null;
  /** ノートのファイルが読めない理由（このときは note が null でも「無い」ではない） */
  noteError: string | null;
  material: ReleaseMaterial;
  /** 保存のあとで材料が変わった（ノートが無ければ false） */
  materialChanged: boolean;
}

export async function releaseNoteDetail(ctx: P3Context, mid: string): Promise<ReleaseNoteDetail> {
  const material = await releaseMaterial(ctx, mid);
  let note: ReleaseNote | null = null;
  let noteError: string | null = null;
  try {
    note = await ctx.ws.releaseNotes.read(mid);
  } catch (e) {
    if (!(e instanceof ReleaseNoteError && e.code === "not_found")) noteError = (e as Error).message;
  }
  return { note, noteError, material, materialChanged: !!note && note.materialHash !== material.hash };
}

export interface SaveInput {
  body: string;
  title?: string;
  /** 本文の元にした材料の hash（生成のプレビューや詳細で受け取ったもの）。今の材料と違えば material_changed を返す */
  basedOn?: string;
  /** 更新のときは読んだときの版（必須）。無ければ新しく作る（既にあれば exists） */
  version?: string;
}

/** 保存する（新規か、版を付けた更新）。出典は保存のときの材料。材料が無くても本文は保存できる（手で書く） */
export async function saveReleaseNote(ctx: P3Context, mid: string, input: SaveInput, actor?: string): Promise<{ note: ReleaseNote; warnings: ReleaseWarning[] }> {
  const material = await releaseMaterial(ctx, mid);
  const write = { title: input.title ?? material.milestone.title, body: input.body, sources: material.sources, materialHash: material.hash };
  const note = input.version === undefined ? await ctx.ws.releaseNotes.create(mid, write, actor) : await ctx.ws.releaseNotes.update(mid, write, input.version, actor);
  ctx.ws.emit({ type: "changed", kind: "release-note", milestone: mid });
  const warnings: ReleaseWarning[] =
    input.basedOn && input.basedOn !== material.hash
      ? [{ code: "material_changed", target: mid, message: "本文の元にした材料のあとで、要望・タスクが変わっています。保存はしました（出典は今の材料）。内容を確かめてください" }]
      : [];
  return { note, warnings };
}

/** 公開する本文だけ（frontmatter・出典は含めない） */
export async function exportReleaseNote(ctx: P3Context, mid: string): Promise<string> {
  const note = await ctx.ws.releaseNotes.read(mid);
  return note.body ? `${note.body}\n` : "";
}

/** 要約の生成を始める（材料はここで固定する。保存はしない）。材料が無ければ Codex を呼ばずに GenerationRejected */
export async function startGeneration(ctx: P3Context, mid: string, actor?: string, engine?: SummaryEngine): Promise<ReleaseGeneration> {
  return ctx.releaseGenerator.start(await releaseMaterial(ctx, mid), actor, engine);
}
