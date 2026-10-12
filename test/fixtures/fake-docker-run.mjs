// テスト用の偽の docker run（app-server がすぐ・途中で終わる場合）。第1引数で振る舞いを決める。
//   mount / nodaemon / noimage / unknown  Docker のよくあるエラーを stderr に書いて終わる
//   zero      何も言わずに終了コード 0 で終わる
//   secret    渡された access token と JWT らしいものを、チャンクをまたいで stderr に書いて終わる
//   signal    SIGKILL で終わる
//   midrun    initialize には答え、次の要求で stderr に書いて終わる（途中で終わる）
//   hang      何も答えない（P3 が止めるまで）
//   flood     stderr を大量に書いて終わる（上限と省略の印）
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2];
// すぐ終わるので、書き終えてから終わるよう同期で書く
const err = (s) => writeSync(2, s);
const tick = () => new Promise((r) => setTimeout(r, 20));
switch (mode) {
  case "mount":
    err('docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /host/repo\n');
    err("See 'docker run --help'.\n");
    process.exit(125);
  case "nodaemon":
    err("docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n");
    process.exit(125);
  case "noimage":
    err("Unable to find image 'llmcs-codex-workspace:local' locally\n");
    err("docker: Error response from daemon: pull access denied for llmcs-codex-workspace, repository does not exist or may require 'docker login'.\n");
    process.exit(125);
  case "unknown":
    err("something odd happened\nthe last line explains it\n");
    process.exit(3);
  case "zero":
    process.exit(0);
  case "secret": {
    const t = process.env.CODEX_ACCESS_TOKEN ?? process.env.ACCESS_TOKEN ?? "";
    err(`auth failed for token ${t.slice(0, 4)}`);
    await tick();
    err(`${t.slice(4)} and jwt eyJhbGciOiJIUzI1`);
    await tick();
    err("NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl\n");
    process.exit(1);
  }
  case "signal":
    err("killed by the kernel\n");
    await tick();
    process.kill(process.pid, "SIGKILL");
    break;
  case "flood":
    for (let i = 0; i < 4000; i++) err(`line ${i} ${"x".repeat(40)}\n`);
    err("final line of the flood\n");
    process.exit(1);
  case "midrun": {
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      const m = JSON.parse(line);
      if (m.method === "initialize") process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} })}\n`);
      else if (m.id !== undefined) {
        err("container ran out of memory\n");
        process.exit(137);
      }
    }
    break;
  }
  case "hang":
    process.stdin.resume();
    setInterval(() => {}, 1000);
    break;
}
