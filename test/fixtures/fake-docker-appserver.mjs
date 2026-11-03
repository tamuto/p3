// テスト用の偽の docker（評価のコンテナ。test/codexContainer.test.ts）。docker run --name <名前> で app-server として答え、
// rm -f <名前> でコンテナを消す。起こしたコンテナは FAKE_CONTAINERS（JSON の配列）に残す。
//   FAKE_MODE  ok（ターンを完了して終わる。--rm なので記録も消える）/
//              stuck（ターンを始めたまま turn/interrupt にも答えない。CLI が止まってもコンテナは残る）
//   FAKE_CALLS 受け取った引数を1行1件で書く
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const { FAKE_CONTAINERS: file, FAKE_CALLS: calls, FAKE_MODE: mode = "ok" } = process.env;
if (calls) appendFileSync(calls, `${JSON.stringify(args)}\n`);
const list = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
const save = (l) => writeFileSync(file, JSON.stringify(l));

if (args[0] === "rm") {
  const name = args.at(-1);
  if (!list().includes(name)) {
    process.stderr.write(`Error response from daemon: No such container: ${name}\n`);
    process.exit(1);
  }
  save(list().filter((c) => c !== name));
  console.log(name);
  process.exit(0);
}

const name = args[args.indexOf("--name") + 1];
save([...list(), name]);
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const end = () => {
  // --rm: 正常に終わったコンテナは消える。stuck は CLI が終わってもコンテナが残ったことにする
  if (mode === "ok") save(list().filter((c) => c !== name));
  process.exit(0);
};
const lines = createInterface({ input: process.stdin });
lines.on("close", end);
process.on("SIGTERM", end);
lines.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { userAgent: "fake" } });
  else if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "th" }, model: "fake" } });
  else if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "tu" } } });
    if (mode === "ok") send({ method: "turn/completed", params: { turn: { id: "tu", status: "completed" } } });
  }
  else if (m.method === "account/rateLimits/read") send({ id: m.id, result: { rateLimits: {} } });
  else if (m.id !== undefined && m.method !== "turn/interrupt") send({ id: m.id, result: {} });
  // stuck: turn/interrupt には答えない
});
