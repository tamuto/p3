import { Hono } from "hono";
import type { P3Context } from "@infodb/p3-tasks/core/context.ts";
import { DefinitionStore } from "@infodb/p3-observer/core/definitionStore.ts";
import { ObservationIndex } from "../../core/observerIndex.ts";

/** 要望の詳細の観測の欄の API（GET /requests/:rid/observations）。アプリが tasks の API より先に付ける */
export function requestObservationsRoute(ctx: P3Context): Hono {
  const index = new ObservationIndex(() => new DefinitionStore(ctx.ws.dataDir).list(), ctx.ws);
  const app = new Hono();
  app.get("/requests/:rid/observations", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await index.forRequest(c.req.param("rid")));
  });
  return app;
}
