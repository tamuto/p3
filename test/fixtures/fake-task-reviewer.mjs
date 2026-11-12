// テスト用の偽 codex app-server（タスクのレビュー）。依頼文の資料（<material> の JSON）から、レビューの JSON を最後の応答で返す。
//   FAKE_LOG      受け取ったメッセージを1行1件で書く
//   FAKE_SCENARIO ok（既定。最初の項目は差分の後の側のファイルを根拠に満たしている、ほかは不足）/ unknown（材料に無いパス）/
//                 badsha（比較対象に無い SHA）/ missing（項目が欠ける）/ duplicate（項目が重なる）/ unknownitem（無い項目）/
//                 broken（JSON でない）/ records（記録だけを根拠に満たしている）/ deleted（削除したファイルを前の側で根拠にする）/
//                 slow（取り消されるまで終わらない）/ usage（使用量の上限で失敗）
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const { FAKE_LOG: log, FAKE_SCENARIO: scenario = "ok" } = process.env;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
let pending;

function result(text) {
  const material = JSON.parse(/<material>\n([\s\S]*?)\n<\/material>/.exec(text)[1]);
  const t = material.targets[0];
  const d = t.diffs[0];
  const added = d.changes.find((c) => c.status !== "D");
  const deleted = d.changes.find((c) => c.status === "D");
  const code =
    scenario === "unknown" ? `${t.repo}@${d.head}:no/such.ts`
    : scenario === "badsha" ? `${t.repo}@${"0".repeat(40)}:${added.path}`
    : scenario === "deleted" ? `${t.repo}@${d.base}:${deleted.path}`
    : `${t.repo}@${d.head.slice(0, 12)}:${added.path}:1`;
  const items = material.items.map((it, i) => ({
    item: scenario === "unknownitem" && i === 0 ? "Z9" : it.id,
    verdict: i === 0 ? "satisfied" : "missing",
    reason: `${it.text} を差分で確かめた`,
    evidence: i === 0 ? (scenario === "records" ? [material.task.ref] : [code, `${t.repo}@${t.commits[0].sha.slice(0, 7)}`, d.patch.replace("/workspace/material/", "")]) : [it.id],
    gaps: i === 0 ? [] : ["見当たらない"],
  }));
  if (scenario === "missing") items.pop();
  if (scenario === "duplicate") items.push(items[0]);
  const body = { overall: "一部が満たされている", items, unplanned: [{ text: "依頼に無い設定の変更", evidence: [`${t.repo}@${d.head}`] }], checks: ["A1 と本文の完了条件が食い違う"], coverage: { read: "差分と前後のコード", unread: "なし" } };
  return scenario === "broken" ? "評価しました（JSON ではありません）" : "```json\n" + JSON.stringify(body) + "\n```";
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
      reply({ thread: { id: `t-${Date.now()}` }, model: "fake-model" });
      break;
    case "turn/start":
      reply({ turn: { id: "u1" } });
      if (scenario === "slow") pending = { id: "u1" };
      else if (scenario === "usage") notify("turn/completed", { turn: { id: "u1", status: "failed", error: { codexErrorInfo: "usageLimitExceeded" } } });
      else complete("u1", m.params.input[0].text);
      break;
    case "turn/interrupt":
      reply({});
      if (pending) notify("turn/completed", { turn: { id: pending.id, status: "interrupted" } });
      break;
    default:
      reply({});
  }
}
