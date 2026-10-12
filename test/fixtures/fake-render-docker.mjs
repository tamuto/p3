#!/usr/bin/env node
// テスト用の描画の docker。呼ばれた引数を FAKE_DOCKER_LOG に1行ずつ書き、FAKE_DOCKER_MODE で振る舞いを変える。
//   ok: /in/jobs.json を読んで /out/<id>.png を書く / partial: 2枚目だけ失敗 / sleep: 終わらない /
//   fail: マウントの失敗 / noreport: 何も出さない / noimage: イメージが無い（build で作る）
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_DOCKER_MODE ?? "ok";
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\n");

if (args[0] === "version") {
  process.stdout.write("29.0.0\n");
  process.exit(0);
}
if (args[0] === "image") process.exit(mode === "noimage" ? 1 : 0);
if (args[0] === "kill" || args[0] === "build") process.exit(0);
if (args[0] !== "run") process.exit(1);

const mount = (dst) => args.find((a) => a.includes(`dst=${dst}`))?.match(/src=([^,]+)/)?.[1];
// テストではパスの対応で付けた接頭辞（/HOST）を外して、このマシンのパスに戻す
const local = (p) => p.replace(/^\/HOST/, "");
if (mode === "sleep") setInterval(() => {}, 1000);
else if (mode === "fail") {
  process.stderr.write('docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /x\n');
  process.exit(125);
} else if (mode === "noreport") process.exit(0);
else {
  const jobs = JSON.parse(readFileSync(join(local(mount("/in")), "jobs.json"), "utf8"));
  const results = jobs.map((j, i) => {
    if (i === 1 && mode === "partial") return { id: j.id, ok: false, error: "page crashed", blocked: [] };
    const png = Buffer.alloc(32);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(j.width, 16);
    png.writeUInt32BE(600, 20);
    writeFileSync(join(local(mount("/out")), `${j.id}.png`), png);
    return { id: j.id, ok: true, clipped: false, blocked: ["http://example.com/a.png"] };
  });
  process.stdout.write(JSON.stringify({ results }) + "\n");
}
