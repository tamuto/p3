import type { P3Context } from "@infodb/p3-tasks/core/context.ts";
import type { WorkRef } from "@infodb/p3-observer/shared/definition.ts";

/**
 * 観測の操作の作業の帰属を確かめる（docs/architecture.md「p3-observer」の期待の履歴と作業の帰属）。observer は tasks を読まないので、
 * 入口（CLI の作業の文脈）とアプリ（画面のタスクの詳細から移った文脈）がここで、同じプロジェクトの作業中のタスクかを確かめてから値で渡す
 */
export function resolveWork(ctx: P3Context, ref: string): { ok: true; work: WorkRef } | { ok: false; reason: string } {
  const t = ctx.ws.task(ref);
  if (!t) return { ok: false, reason: `作業の文脈のタスクがこのプロジェクトにありません: ${ref}` };
  if (t.status !== "doing") return { ok: false, reason: `作業の文脈のタスク ${ref} は作業中ではありません（${t.status}）` };
  return { ok: true, work: { request: t.request, task: t.id } };
}
