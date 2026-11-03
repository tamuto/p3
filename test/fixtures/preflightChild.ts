// test/preflightRecover.test.ts の子プロセス。要望の Preflight を、終わらないエンジンで始めて待ち続ける（親が強制終了する）。
// 標準出力に始めた run の ID を出す
import { PreflightService } from "../../src/core/preflight/service.ts";
import { Workspace } from "../../src/core/store/workspace.ts";

const [dataDir, requestId] = process.argv.slice(2);
const ws = new Workspace(dataDir);
await ws.load();
// 終わらない（中止されたときだけ止まる）エンジン
const never = {
  name: "mock" as const,
  status: async () => ({ name: "mock" as const, ok: true, detail: "" }),
  run: (_job: unknown, _log: unknown, signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
};
const service = new PreflightService(ws, { mock: never }, "mock");
const run = await service.start(requestId, { actor: "test" });
process.stdout.write(`started ${run.id}\n`);
const timer = setInterval(() => {}, 60_000);
// 止まったら（中断の依頼を見て止めた）知らせて終わる
await service.wait(requestId, run.id);
process.stdout.write(`finished ${(await ws.preflight.get(requestId, run.id))?.status}\n`);
clearInterval(timer);
