import { Hono } from "hono";
import type { P3Context } from "@infodb/p3-tasks/core/context.ts";
import { DefinitionStore } from "@infodb/p3-observer/core/definitionStore.ts";
import { ObservationIndex } from "../../core/observerIndex.ts";
import { followUpSources } from "../../core/observerFollowUp.ts";

/** 要望の詳細の観測の欄の API（GET /requests/:rid/observations）。この要望を作った観測の結果（要望のタグから）も返す。アプリが tasks の API より先に付ける */
export function requestObservationsRoute(ctx: P3Context): Hono {
  const index = new ObservationIndex(() => new DefinitionStore(ctx.ws.dataDir).list(), ctx.ws);
  const app = new Hono();
  app.get("/requests/:rid/observations", async (c) => {
    c.header("cache-control", "no-store");
    const rid = c.req.param("rid");
    const defs = new DefinitionStore(ctx.ws.dataDir);
    const tags = ctx.ws.requests.list().find((r) => r.id === rid)?.tags ?? [];
    const results = await Promise.all(followUpSources(tags).map(async (s) => ({ ...s, title: (await defs.get(s.observation).catch(() => undefined))?.title })));
    return c.json({ ...(await index.forRequest(rid)), results });
  });
  return app;
}
