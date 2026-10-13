// テスト用の偽 codex app-server。@infodb/codex-workspace と JSON-RPC で話し、
// preflight の指示文から run ディレクトリを読み取って、assessment.json と drafts/*.md を書く。
//   FAKE_REPO     作業場所（コンテナの /workspace に当たる。受け取るが読み書きしない）
//   FAKE_DATA     データディレクトリ（コンテナの /data に当たる）
//   FAKE_LOG      受け取ったメッセージを1行1件で書く
//   FAKE_SUPERSEDE 置き換えられるタスクの参照（<要望ID>/T001）。D2 の supersedes に書く
//   FAKE_EVIDENCE  assessment.json の evidence（JSON の配列）
//   FAKE_SCENARIO usage（上限に当たっている） / stray（run ディレクトリの外も変更する） / broken（壊れた JSON を書く） /
//                 ui（画面イメージの原稿と一覧を書く。画像は書かない） / nonui（画面を伴わないと書く）
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const { FAKE_DATA: data, FAKE_LOG: log, FAKE_SCENARIO: scenario, FAKE_SUPERSEDE: supersede = "" } = process.env;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

function runTurn(id, text) {
  if (scenario === "unauthorized") {
    // 本物の Codex のように、キーの一部を見せるエラーを返す（トークンそのものも混ぜて、伏せられるか確かめる）
    const t = process.env.ACCESS_TOKEN ?? "";
    const message = `unexpected status 401 Unauthorized: Incorrect API key provided: ${t.slice(0, 8)}***${t.slice(-3)}. raw=${t}`;
    notify("error", { error: { message } });
    notify("turn/completed", { turn: { id, status: "failed", error: { message } } });
    return;
  }
  // run ディレクトリはコンテナの中のパス（/data/requests/.../preflight/PF-...）で伝えられる
  const runDir = /(\/data\/[^\s`]+)\/assessment\.json/.exec(text)?.[1];
  const abs = join(data, runDir.slice("/data".length));
  mkdirSync(join(abs, "drafts"), { recursive: true });
  const assessment = {
    summary: "偽の評価",
    verdict: "go",
    validity: { score: 90, reasons: ["妥当"] },
    feasibility: { score: 150, reasons: ["範囲外の点数は丸められる"] },
    risks: [],
    questions: [],
    areas: ["src/a"],
    // FAKE_EVIDENCE: 判断の根拠（JSON の配列）。無ければ書かない（以前の結果と同じ）
    ...(process.env.FAKE_EVIDENCE ? { evidence: JSON.parse(process.env.FAKE_EVIDENCE) } : {}),
  };
  writeFileSync(join(abs, "assessment.json"), scenario === "broken" ? "{ not json" : JSON.stringify(assessment));
  writeFileSync(join(abs, "drafts", "D1.md"), "---\nkey: D1\ntitle: 下準備\ndependsOn: []\n---\n\n準備する\n");
  writeFileSync(
    join(abs, "drafts", "D2.md"),
    `---\nkey: D2\ntitle: 本体\ndependsOn: [D1]\n${supersede ? `supersedes: [${supersede.split("/").pop()}, T404]\n` : ""}---\n\n作る\n`,
  );
  const changes = [`${runDir}/assessment.json`, `${runDir}/drafts/D1.md`, `${runDir}/drafts/D2.md`];
  if (scenario === "ui" || scenario === "nonui") {
    mkdirSync(join(abs, "ui", "src"), { recursive: true });
    const index =
      scenario === "nonui"
        ? { needed: false, reason: "CLI だけの変更で画面は変わらない" }
        : {
            needed: true,
            targets: ["D2"],
            items: [
              // rendered は P3 だけが書く（エンジンが書いても消される）
              { id: "U1", html: "src/U1.html", title: "一覧の絞り込み", drafts: ["D2"], viewport: 1024, assumptions: ["仮のデータ"], rendered: { by: "p3" } },
            ],
          };
    if (scenario === "ui") writeFileSync(join(abs, "ui", "src", "U1.html"), "<!doctype html><html lang=\"ja\"><body><h1>一覧</h1><button>絞り込む</button></body></html>");
    writeFileSync(join(abs, "ui", "index.json"), JSON.stringify(index));
    changes.push(`${runDir}/ui/index.json`, ...(scenario === "ui" ? [`${runDir}/ui/src/U1.html`] : []));
  }
  notify("item/completed", { item: { type: "commandExecution", id: "c1", command: "rg -l foo", exitCode: 0 } });
  if (scenario === "stray") changes.push("/workspace/main/src/main.ts");
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
    case "initialize":
      // 名乗りと、環境変数で渡された access token（ChatGPT プラン）を記録する
      appendFileSync(log, `${JSON.stringify({ clientInfo: m.params?.clientInfo, accessToken: process.env.ACCESS_TOKEN ?? null })}\n`);
      reply({});
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
