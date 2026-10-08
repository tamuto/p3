// テスト用の偽 codex app-server。@llmcs/codex-workspace と JSON-RPC で話し、
// preflight の指示文から run ディレクトリを読み取って、assessment.json と drafts/*.md を書く。
//   FAKE_TARGET   既存のタスクの参照（<要望ID>/T001）。影響・関係の相手にする
//   FAKE_REPO     作業場所（コンテナの /workspace に当たる）
//   FAKE_LOG      受け取ったメッセージを1行1件で書く
//   FAKE_SCENARIO usage（上限に当たっている） / stray（run ディレクトリの外も変更する） / broken（壊れた JSON を書く）
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const { FAKE_REPO: repo, FAKE_LOG: log, FAKE_SCENARIO: scenario, FAKE_TARGET: target = "" } = process.env;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

function runTurn(id, text) {
  const runDir = /([^\s`]+)\/assessment\.json/.exec(text)?.[1];
  const abs = join(repo, runDir);
  mkdirSync(join(abs, "drafts"), { recursive: true });
  const assessment = {
    summary: "偽の評価",
    verdict: "go",
    validity: { score: 90, reasons: ["妥当"] },
    feasibility: { score: 150, reasons: ["範囲外の点数は丸められる"] },
    risks: [],
    questions: [],
    areas: ["src/a"],
    impacts: [
      { target, type: "impacts", reason: "同じ領域", confidence: 0.8 },
      { target, type: "bogus", reason: "不正な種類は捨てられる" },
      { target: "261001-nopee/T009", type: "impacts", reason: "存在しない相手はタスク化で捨てられる" },
    ],
  };
  writeFileSync(join(abs, "assessment.json"), scenario === "broken" ? "{ not json" : JSON.stringify(assessment));
  writeFileSync(join(abs, "drafts", "D1.md"), "---\nkey: D1\ntitle: 下準備\nestimateDays: 1\ndependsOn: []\n---\n\n準備する\n");
  writeFileSync(
    join(abs, "drafts", "D2.md"),
    `---\nkey: D2\ntitle: 本体\nestimateDays: 2\ndependsOn: [D1]\nrelations:\n  - { type: relates_to, target: ${target} }\n---\n\n作る\n`,
  );
  notify("item/completed", { item: { type: "commandExecution", id: "c1", command: "rg -l foo", exitCode: 0 } });
  const changes = [`/workspace/${runDir}/assessment.json`, `/workspace/${runDir}/drafts/D1.md`, `/workspace/${runDir}/drafts/D2.md`];
  if (scenario === "stray") changes.push("/workspace/src/main.ts");
  notify("item/completed", { item: { type: "fileChange", id: "p1", changes: changes.map((path) => ({ path, kind: "add" })) } });
  notify("item/completed", { item: { type: "agentMessage", id: "m1", text: "書きました" } });
  notify("turn/completed", { turn: { id, status: "completed" } });
}

for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  appendFileSync(log, `${line}\n`);
  if (!("id" in m) || !("method" in m)) continue;
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "account/rateLimits/read":
      reply({
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 300 },
          secondary: { usedPercent: 20, windowDurationMins: 10080 },
          rateLimitReachedType: scenario === "usage" ? "primary" : null,
        },
        ordinaryUsageAllowed: scenario !== "usage",
      });
      break;
    case "thread/start":
      reply({ thread: { id: "t1" }, model: "fake-model" });
      break;
    case "turn/start":
      reply({ turn: { id: "u1" } });
      runTurn("u1", m.params.input[0].text);
      break;
    default:
      reply({});
  }
}
