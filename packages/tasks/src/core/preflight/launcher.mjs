// app-server（docker run）を起こす小さな中継。@infodb/codex-workspace は app-server の stderr を捨てるので、
// その間に入って stdin / stdout（JSON-RPC）はそのまま通し、stderr と終わり方だけを診断のフォルダに書く。
//
//   node launcher.mjs <診断のフォルダ> -- <コマンド> [引数...]
//
//   <フォルダ>/pid      この中継のプロセス ID（初期化に失敗したとき P3 が止めるため）
//   <フォルダ>/stderr   子の stderr（先頭と末尾を残して上限まで。秘密は P3 が読むときに伏せる）
//   <フォルダ>/exit.json { code, signal } か { spawnError }。子が終わって出力を出し切ってから書く
//
// 止めるとき（SIGTERM / SIGINT / SIGHUP・stdin が閉じた）は子に伝え、子が終わるのを待ってから終わる。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, sep, file, ...args] = process.argv.slice(2);
if (!dir || sep !== "--" || !file) {
  process.stderr.write("使い方: launcher.mjs <フォルダ> -- <コマンド> [引数...]\n");
  process.exit(2);
}
const write = (name, text) => writeFileSync(join(dir, name), text, { mode: 0o600 });
write("pid", String(process.pid));

/** 先頭 HEAD バイトと末尾 TAIL バイトを残す（最後の行が一番大事なので末尾を多めに） */
const HEAD = 8 * 1024;
const TAIL = 56 * 1024;
let head = Buffer.alloc(0);
let tail = Buffer.alloc(0);
let dropped = 0;
const keep = (chunk) => {
  if (head.length < HEAD) {
    const take = Math.min(HEAD - head.length, chunk.length);
    head = Buffer.concat([head, chunk.subarray(0, take)]);
    chunk = chunk.subarray(take);
  }
  tail = Buffer.concat([tail, chunk]);
  if (tail.length > TAIL) {
    dropped += tail.length - TAIL;
    tail = tail.subarray(tail.length - TAIL);
  }
};
const flushStderr = () => {
  const mid = dropped ? Buffer.from(`\n…（${dropped} バイトを省略）…\n`) : Buffer.alloc(0);
  write("stderr", Buffer.concat([head, mid, tail]));
};

let child;
try {
  child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
} catch (e) {
  write("exit.json", JSON.stringify({ spawnError: e.code ?? e.message }));
  process.exit(127);
}
child.once("error", (e) => {
  // 起動できなかった（コマンドが無いなど）
  write("exit.json", JSON.stringify({ spawnError: e.code ?? e.message }));
  process.exit(127);
});

process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
process.stdout.on("error", () => {});
child.stdout.pipe(process.stdout);
child.stderr.on("data", keep);

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));

// close は出力を出し切った後に来る（exit より後）
child.once("close", (code, signal) => {
  flushStderr();
  write("exit.json", JSON.stringify({ code, signal }));
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
