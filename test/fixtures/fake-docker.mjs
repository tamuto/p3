// テスト用の偽 docker。@infodb/codex-workspace の ensureImage と p3 codex update が使う操作だけに答える。
//   FAKE_DOCKER_STATE     イメージの状態を置くファイル（JSON: { created, version }）。無ければイメージが無い
//   FAKE_DOCKER_LOG       受け取った引数を1行1件で書く
//   FAKE_DOCKER_SCENARIO  nodaemon（デーモンに繋がらない）/ buildfail（作れない）/ versionfail（版を読めない）/
//                         versionhang（版を出した後も終わらない。コンテナは残る）/ inspecthang / buildhang（終わらない）/
//                         rmhang（rm -f が終わらない）。カンマ区切りで複数
//   コンテナ: run --name <名前> で起こしたものを <STATE>.containers.json に残し、--rm で終われば消す。rm -f <名前> で消す（無ければ No such container）
//   FAKE_DOCKER_VERSION   作り直したときに入る Codex の版（既定 codex-cli 9.9.9）
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const { FAKE_DOCKER_STATE: state, FAKE_DOCKER_LOG: log, FAKE_DOCKER_SCENARIO: scenario = "" } = process.env;
if (log) appendFileSync(log, `${JSON.stringify(args)}\n`);
const image = () => (state && existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null);
const has = (s) => scenario.split(",").includes(s);
const hang = () => setInterval(() => {}, 1_000_000);
const containersFile = `${state ?? "/tmp/fake-docker"}.containers.json`;
const containers = () => (existsSync(containersFile) ? JSON.parse(readFileSync(containersFile, "utf8")) : []);
const setContainers = (list) => writeFileSync(containersFile, JSON.stringify(list));
const fail = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};

switch (args[0]) {
  case "version":
    if (scenario === "nodaemon") fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
    console.log("27.0.0");
    break;
  case "image": {
    if (has("inspecthang")) {
      hang();
      break;
    }
    const img = image();
    if (!img) fail("Error response from daemon: No such image");
    console.log(args.includes("{{.Created}}") ? img.created : "sha256:fake");
    break;
  }
  case "build":
    if (has("buildhang")) {
      hang();
      break;
    }
    if (scenario === "buildfail") fail("ERROR: failed to solve: process \"/bin/sh -c curl ...\" did not complete successfully: exit code: 6");
    writeFileSync(state, JSON.stringify({ created: new Date().toISOString(), version: process.env.FAKE_DOCKER_VERSION ?? "codex-cli 9.9.9" }));
    console.log("sha256:new");
    break;
  case "run": {
    const img = image();
    if (!img) fail("Unable to find image locally");
    const at = args.indexOf("--name");
    const name = at >= 0 ? args[at + 1] : undefined;
    if (name) setContainers([...containers(), name]);
    if (scenario === "versionfail" && args.at(-1) === "--version") fail("exec: codex: not found");
    console.log(img.version);
    if (has("versionhang") && args.at(-1) === "--version") {
      hang();
      break;
    }
    // --rm: 終わったコンテナは消える
    if (name && args.includes("--rm")) setContainers(containers().filter((c) => c !== name));
    break;
  }
  case "rm": {
    if (has("rmhang")) {
      hang();
      break;
    }
    const name = args.at(-1);
    if (!containers().includes(name)) fail(`Error response from daemon: No such container: ${name}`);
    setContainers(containers().filter((c) => c !== name));
    console.log(name);
    break;
  }
  default:
    fail(`unknown: ${args.join(" ")}`);
}
