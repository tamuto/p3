// テスト用の偽 codex app-server（マイルストーンのレビュー）。依頼文の資料（<material> の JSON）から、レビューの JSON を最後の応答で返す。
//   FAKE_LOG      受け取ったメッセージを1行1件で書く
//   FAKE_SCENARIO ok（既定。読める参照先があればコードの場所とコミットを根拠にする）/ unknown（資料に無い根拠）/ missing（比較単位が欠ける）/
//                 broken（JSON でない）/ slow（取り消されるまで終わらない）/ usage（使用量の上限で失敗）/ late（取り消されても結果を返す）/
//                 records（記録だけを根拠に「達成」）/ badpath（参照先に無いパスを根拠にする）/
//                 qregression（品質の低下をコミットで裏付ける）/ qbadregression（コミット無しで品質の低下）/ qmissing（品質の判定が欠ける）
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const { FAKE_LOG: log, FAKE_SCENARIO: scenario = "ok" } = process.env;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
let pending;

function result(text) {
  const material = JSON.parse(/<material>\n([\s\S]*?)\n<\/material>/.exec(text)[1]);
  const first = material.requests[0];
  const code = (material.code ?? []).find((c) => c.path);
  const commit = code?.commits.find((c) => c.found);
  const codeEvidence = code ? [`${code.name}:${scenario === "badpath" ? "no/such.ts" : "src/stock.ts:1"}`, ...(commit ? [`${code.name}@${commit.sha.slice(0, 7)}`] : [])] : [];
  const units = material.units.map((u, i) => ({
    unit: u.id,
    verdict: scenario === "records" ? "achieved" : i === 0 && first ? (code ? "achieved" : "partial") : "insufficient",
    reason: `${u.text} の実装を読んだ`,
    evidence: scenario === "unknown" ? ["999999-zzzzz"] : [...(first ? [first.id] : []), ...(i === 0 && scenario !== "records" ? codeEvidence : [])],
    gaps: ["通知の再送が未完了"],
  }));
  if (scenario === "missing") units.pop();
  const unplanned = commit ? [{ text: "一覧の並び順が変わっている", evidence: [`${code.name}@${commit.sha}`] }] : [];
  const qs = material.quality?.standards ?? [];
  const quality = qs.map((q, i) => ({
    standard: q.id,
    verdict: i === 0 ? "violated" : "undetermined",
    reason: i === 0 ? "lint の設定を消している" : "読めない",
    evidence: i === 0 ? (scenario === "qbadregression" ? [codeEvidence[0]] : [...codeEvidence]) : [],
    ...(i === 0 && (scenario === "qregression" || scenario === "qbadregression") ? { regression: true } : {}),
  }));
  if (scenario === "qmissing") quality.pop();
  return scenario === "broken" ? "評価しました（JSON ではありません）" : "```json\n" + JSON.stringify({ overall: "目的の一部が果たせている", units, unplanned, ...(qs.length ? { quality } : {}) }) + "\n```";
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
