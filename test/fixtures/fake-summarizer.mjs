// テスト用の偽 codex app-server（リリースノートの要約）。依頼文の資料（<material> の JSON）から、要約の JSON を最後の応答で返す。
//   FAKE_LOG      受け取ったメッセージを1行1件で書く
//   FAKE_SCENARIO ok（既定）/ unknown（材料に無い出典）/ broken（JSON でない）/ slow（取り消されるまで終わらない）/
//                 usage（使用量の上限で失敗）/ path（ローカルのパスを含む要約）
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const { FAKE_LOG: log, FAKE_SCENARIO: scenario = "ok" } = process.env;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
let pending;

function runTurn(id, text) {
  if (scenario === "slow") {
    pending = id;
    return;
  }
  if (scenario === "usage") {
    notify("turn/completed", { turn: { id, status: "failed", error: { codexErrorInfo: "usageLimitExceeded" } } });
    return;
  }
  const material = JSON.parse(/<material>\n([\s\S]*?)\n<\/material>/.exec(text)[1]);
  const items = material.requests.map((r) => ({
    text: scenario === "path" ? `${r.title} を /workspaces/app/src で直した` : `${r.title}ができるようになった`,
    sources: scenario === "unknown" ? ["999999-zzzzz/T001"] : [r.id, ...r.tasks.map((t) => t.ref)],
  }));
  const message = scenario === "broken" ? "要約しました（JSON ではありません）" : "```json\n" + JSON.stringify({ items }) + "\n```";
  notify("item/completed", { item: { type: "agentMessage", id: "m1", text: message } });
  notify("turn/completed", { turn: { id, status: "completed" } });
}

for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  appendFileSync(log, `${line}\n`);
  if (!("id" in m) || !("method" in m)) continue;
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "account/rateLimits/read":
      reply({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 }, rateLimitReachedType: null }, ordinaryUsageAllowed: true });
      break;
    case "thread/start":
      reply({ thread: { id: "t1" }, model: "fake-model" });
      break;
    case "turn/start":
      reply({ turn: { id: "u1" } });
      runTurn("u1", m.params.input[0].text);
      break;
    case "turn/interrupt":
      reply({});
      if (pending) notify("turn/completed", { turn: { id: pending, status: "interrupted" } });
      break;
    default:
      reply({});
  }
}
