// test/dataWatcher.test.ts の子プロセス。通常の serve（startServer。データのフォルダを実際に監視する）を動かし、標準入力の指示に答える。
// 未処理の例外・拒否は握り潰さず、印を付けて 0 以外で終わる（親が終了コードと標準エラーで見る）
import { createInterface } from "node:readline";
import { resolveMachineSettings } from "../../src/core/machineSettings.ts";
import { startServer } from "../../src/server/server.ts";

process.on("uncaughtException", (e) => {
  process.stderr.write(`uncaught: ${e?.stack ?? e}\n`);
  process.exit(70);
});
process.on("unhandledRejection", (e) => {
  process.stderr.write(`unhandledRejection: ${String(e)}\n`);
  process.exit(71);
});

const [dataDir, port] = process.argv.slice(2);
const server = await startServer({ dataDir, port: Number(port), host: "127.0.0.1", static: false, settings: resolveMachineSettings({ settings: {} }, {}) });
process.stdout.write("ready\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line === "close") void closeAll();
});

async function closeAll() {
  await server.close({ timeoutMs: 2000 });
  rl.close();
  process.stdin.destroy(); // 指示の入力も閉じる（これで残るものが無ければ、自分で終わる）
  process.stdout.write("closed\n");
  // 監視・遅らせた通知・立て直しの時計が残っていれば出す（unref なので、残っていなければこれを待たずに終わる）
  setTimeout(() => process.stdout.write(`left ${JSON.stringify(process.getActiveResourcesInfo())}\n`), 2_000).unref();
}
