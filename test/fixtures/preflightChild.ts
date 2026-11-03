// test/preflightRecover.test.ts の子プロセス。要望の Preflight を、終わらないエンジンで始めて待ち続ける（親が強制終了する）。
// 標準出力に始めた run の ID を出す
import { PreflightService } from "../../src/core/preflight/service.ts";
import { Workspace } from "../../src/core/store/workspace.ts";

const [dataDir, requestId] = process.argv.slice(2);
const ws = new Workspace(dataDir);
await ws.load();
const never = {
  name: "mock" as const,
  status: async () => ({ name: "mock" as const, ok: true, detail: "" }),
  run: () => new Promise<never>(() => {}),
};
const service = new PreflightService(ws, { mock: never }, "mock");
const run = await service.start(requestId, { actor: "test" });
process.stdout.write(`started ${run.id}\n`);
setInterval(() => {}, 60_000);
