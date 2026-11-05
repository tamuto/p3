// テスト用の偽 codex app-server（マイルストーンのレビュー）。依頼文の資料（<material> の JSON）から、レビューの JSON を最後の応答で返す。
//   FAKE_LOG      受け取ったメッセージを1行1件で書く
//   FAKE_SCENARIO ok（既定）/ unknown（資料に無い根拠）/ missing（比較単位が欠ける）/ broken（JSON でない）/
//                 slow（取り消されるまで終わらない）/ usage（使用量の上限で失敗）/ late（取り消されても結果を返す）
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const { FAKE_LOG: log, FAKE_SCENARIO: scenario = "ok" } = process.env;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
let pending;

function result(text) {
  const material = JSON.parse(/<material>\n([\s\S]*?)\n<\/material>/.exec(text)[1]);
  const first = material.requests[0];
  const units = material.units.map((u, i) => ({
    unit: u.id,
    verdict: i === 0 && first ? "partial" : "insufficient",
    reason: `${u.text} の記録を読んだ`,
    evidence: scenario === "unknown" ? ["999999-zzzzz"] : first ? [first.id] : [],
    gaps: ["通知の再送が未完了"],
  }));
  if (scenario === "missing") units.pop();
  return scenario === "broken" ? "評価しました（JSON ではありません）" : "```json\n" + JSON.stringify({ overall: "目的の一部が果たせている", units }) + "\n```";
}

function complete(id, text) {
  notify("item/completed", { item: { type: "agentMessage", id: "m1", text: result(text) } });
  notify("turn/completed", { turn: { id, status: "completed" } });
}

for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  appendFileSync(log, `${line}\n`);
  if (!("id" in m) || !("method" in m)) continue;
  const reply = (r) => send({ jsonrpc: "2.0", id: m.id, result: r });
  switch (m.method) {
    case "account/rateLimits/read":
      reply({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 }, rateLimitReachedType: null }, ordinaryUsageAllowed: true });
      break;
    case "thread/start":
      reply({ thread: { id: "t1" }, model: "fake-model" });
      break;
    case "turn/start":
      reply({ turn: { id: "u1" } });
      if (scenario === "slow" || scenario === "late") pending = { id: "u1", text: m.params.input[0].text };
      else if (scenario === "usage") notify("turn/completed", { turn: { id: "u1", status: "failed", error: { codexErrorInfo: "usageLimitExceeded" } } });
      else complete("u1", m.params.input[0].text);
      break;
    case "turn/interrupt":
      reply({});
      if (pending && scenario === "late") complete(pending.id, pending.text);
      else if (pending) notify("turn/completed", { turn: { id: pending.id, status: "interrupted" } });
      break;
    default:
      reply({});
  }
}
