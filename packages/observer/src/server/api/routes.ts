import { Hono, type Context } from "hono";
import { observerStatus } from "../../core/status.ts";
import { MetricError, MetricStore, type MetricErrorCode } from "../../core/metricStore.ts";
import type { MetricTarget } from "../../shared/status.ts";

const STATUS: Record<MetricErrorCode, 400 | 403 | 404 | 409 | 422> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, in_use: 409, unreadable: 422 };

/**
 * observer の API。アプリの serve が /api/observer（プロジェクトを跨ぐ serve は /api/projects/<名前>/observer）の下に付ける。
 *   GET    /status                     起動状態（ObserverStatus）。プロジェクトを決めなくても使える
 *   GET    /keys?milestone=<ID>        項目キーの一覧（システムの項目を含む）と最後の値・値の数・値に付いたマイルストーン { keys, milestones, unreadable }
 *   POST   /keys                       項目キーを登録する（{ key, name, description?, type, unit?, guide? }）。201
 *   GET    /keys/:key?milestone=<ID>   項目キーと値（新しい順）{ key, values }
 *   PUT    /keys/:key                  変える（{ rev, name, description?, type, unit?, guide? }）。版が違えば 409（current に今の定義）
 *   DELETE /keys/:key?rev=<版>         消す（値があれば 409 の in_use）
 *   POST   /keys/:key/values           値を足す（{ value, at?, target?, milestone?, note? }）。201
 *   DELETE /keys/:key/values/:id       値を消す
 * システムの項目（p3. で始まる）は作る・変える・消す・値を足す・消すのどれも 403（p3 が tasks の操作のその場で記録する）。
 * 入力の誤りは 400 の { error, code: "invalid", problems: [{ path, message }] }（CLI・画面と同じ検証）。
 * target を渡さないとき（プロジェクトを決めていない）は /status だけを付ける。プロジェクトを跨ぐ serve の登録世代はアプリが確かめる
 */
export function observerRoutes(opts: { products?: readonly string[]; target?: MetricTarget } = {}) {
  const app = new Hono();
  app.onError((e, c) => {
    if (!(e instanceof MetricError)) throw e;
    return c.json({ error: e.message, code: e.code, ...(e.problems.length ? { problems: e.problems } : {}), ...(e.current ? { current: e.current } : {}) }, STATUS[e.code]);
  });
  app.use("*", async (c, next) => {
    await next();
    if (c.req.method === "GET") c.header("cache-control", "no-store");
  });
  app.get("/status", (c) => c.json({ ...observerStatus(), ...(opts.products ? { products: [...opts.products] } : {}) }));
  if (!opts.target) return app;
  const store = new MetricStore(opts.target.dataDir);
  const actorOf = (c: Context) => c.req.header("x-p3-actor") ?? "human:web";
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const b: unknown = await c.req.json().catch(() => undefined);
    return typeof b === "object" && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  };
  const milestone = (c: Context) => c.req.query("milestone") || undefined;
  const rev = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
    if (!Number.isInteger(n)) throw new MetricError("invalid", "読んだときの版（rev）を添えてください", [{ path: "rev", message: "版が要ります" }]);
    return n;
  };
  app.get("/keys", async (c) => c.json(await store.list(milestone(c))));
  app.post("/keys", async (c) => c.json(await store.createKey(await body(c), actorOf(c)), 201));
  app.get("/keys/:key", async (c) => c.json(await store.get(c.req.param("key"), milestone(c))));
  app.put("/keys/:key", async (c) => {
    const b = await body(c);
    return c.json(await store.updateKey(c.req.param("key"), rev(b.rev), b, actorOf(c)));
  });
  app.delete("/keys/:key", async (c) => {
    await store.deleteKey(c.req.param("key"), rev(c.req.query("rev")));
    return c.json({ deleted: c.req.param("key") });
  });
  app.post("/keys/:key/values", async (c) => c.json(await store.addValue(c.req.param("key"), await body(c), actorOf(c)), 201));
  app.delete("/keys/:key/values/:id", async (c) => {
    await store.deleteValue(c.req.param("key"), c.req.param("id"));
    return c.json({ deleted: c.req.param("id") });
  });
  return app;
}
