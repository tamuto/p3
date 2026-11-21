import type { P3Context } from "@infodb/p3-tasks/core/context.ts";
import { createRequest } from "@infodb/p3-tasks/core/requestOps.ts";
import type { FollowUpAdapter } from "@infodb/p3-observer/shared/result.ts";

/**
 * 観測の結果から作る要望（docs/architecture.md「p3-observer」の観測の実行と結果）。observer は tasks を読まないので、アプリが tasks の
 * createRequest で下書きの要望を作り、結果との結び付きを要望のタグ（observation-result:<観測ID>/<結果ID>）で持つ（結果のファイルは変えない）。
 * タグで探すので、作った後に落ちても次に探せば見つかる（重ねて作らない）
 */
const PREFIX = "observation-result:";
export const followUpTag = (observation: string, result: string) => `${PREFIX}${observation}/${result}`;

/** 要望のタグから、その要望を作った観測の結果を読む */
export function followUpSources(tags: readonly string[]): { observation: string; result: string }[] {
  return tags.flatMap((t) => {
    const m = t.startsWith(PREFIX) ? /^(obs-[^/]+)\/(res-.+)$/.exec(t.slice(PREFIX.length)) : null;
    return m ? [{ observation: m[1], result: m[2] }] : [];
  });
}

export function followUpAdapter(ctx: P3Context): FollowUpAdapter {
  return {
    async find(observation, result) {
      const r = ctx.ws.requests.list().find((x) => x.tags.includes(followUpTag(observation, result)));
      return r && { request: r.id, title: r.title, status: r.status };
    },
    async create(observation, result, draft, actor) {
      const r = await createRequest(ctx, { title: draft.title, body: draft.body, tags: [followUpTag(observation, result)] }, actor);
      return { request: r.id, title: r.title, status: r.status };
    },
  };
}
