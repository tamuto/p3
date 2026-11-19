import { applyQualityOps, templateDiffs, type QualityOp, type QualityState, type QualityTemplate, type TemplateDiff } from "../shared/quality.ts";
import { QUALITY_TEMPLATES } from "../shared/qualityTemplates.ts";
import type { Workspace } from "./store/workspace.ts";

/**
 * 品質基準の操作（CLI の p3 quality・API の /quality はここを呼ぶ）。規則は shared/quality.ts、テンプレートは shared/qualityTemplates.ts。
 * 書くのは project.yaml の quality だけで、書く直前にロックの中で読み直した最新の値に操作を当てる（版が違えば quality_conflict）。
 * コマンドの実行・依存の導入はしない
 */

export interface QualityView {
  quality: QualityState;
  version: string;
  /** 採用したテンプレートの今の版との差分（当てるのは upgrade の操作で明示する） */
  diffs: TemplateDiff[];
  templates: { id: string; version: number; title: string; description: string; items: number }[];
}

export function qualityView(ws: Workspace, templates: readonly QualityTemplate[] = QUALITY_TEMPLATES): QualityView {
  const quality = ws.project.quality ?? { state: "unset" as const };
  return {
    quality,
    version: ws.project.qualityVersion ?? "",
    diffs: quality.state === "set" ? templateDiffs(quality.config, templates) : [],
    templates: templates.map((t) => ({ id: t.id, version: t.version, title: t.title, description: t.description, items: t.items.length })),
  };
}

export function qualityTemplate(id: string, version?: number, templates: readonly QualityTemplate[] = QUALITY_TEMPLATES): QualityTemplate | undefined {
  const list = templates.filter((t) => t.id === id && (version === undefined || t.version === version));
  return list.sort((a, b) => b.version - a.version)[0];
}

/** 操作を当てて保存する（expectedVersion: 編集を始めたときの版） */
export async function updateQuality(ws: Workspace, ops: readonly QualityOp[], opts: { expectedVersion?: string; templates?: readonly QualityTemplate[] } = {}): Promise<QualityView> {
  const templates = opts.templates ?? QUALITY_TEMPLATES;
  await ws.writeQuality((cur) => applyQualityOps(cur.quality ?? { state: "unset" }, ops, { repoNames: cur.repos.map((r) => r.name), templates }), { expectedVersion: opts.expectedVersion });
  return qualityView(ws, templates);
}
