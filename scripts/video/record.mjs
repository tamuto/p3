#!/usr/bin/env node
// p3 の使い方の動画（一般公開用。日本語の字幕、約3分）を録り、mp4 にする。
//
//   pnpm video [--out <mp4>] [--keep-frames]
//
//   1. 使い捨ての HOME（/home/me）に、架空の経費精算アプリのリポジトリを作る（demo-repo.sh）。映るパスを汎用にするため
//   2. ターミナルの場面（term.html）と画面の場面（p3 serve）を、1つのページで続けて録る（CDP の screencast。JPEG のフレーム）
//      ① 導入 → ② 要望の登録 → ③ Preflight → ④ 作業 → ⑤ 確認とリリース。Preflight とリリースノートの要約は Mock
//   3. ffmpeg でフレームを mp4 にまとめる（既定は .p3-video/p3-demo.mp4。git 管理外）
//
// 前提: playwright-core の Chromium（pnpm exec playwright-core install chromium-headless-shell）、ffmpeg（libx264）、
// 日本語のフォント Noto Sans CJK JP（fonts-noto-cjk）、/home/me を作れること、ポート 4310 が空いていること。
// 画面の文言や操作が変わって操作の対象が見つからなければ、場面と操作の名前・その時の画面の画像を出して止める。
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const P3_BIN = join(ROOT, "bin/p3.mjs");
const DEMO_HOME = "/home/me";
const REPO = join(DEMO_HOME, "src/expense");
const PORT = 4310;
const BASE = `http://localhost:${PORT}`;

const args = process.argv.slice(2);
const OUT = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : join(ROOT, ".p3-video/p3-demo.mp4"));
const KEEP = args.includes("--keep-frames");

const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))),
  HOME: DEMO_HOME,
  XDG_CONFIG_HOME: join(DEMO_HOME, ".config"),
  P3_PREFLIGHT_ENGINE: "mock",
  PATH: `${join(DEMO_HOME, "bin")}:${process.env.PATH}`,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, o = {}) =>
  execSync(`${cmd} 2>&1`, { cwd: o.cwd ?? REPO, env: { ...ENV, ...o.env }, encoding: "utf8", shell: "/bin/bash", input: o.input });
const fail = (msg) => {
  console.error(`録画を始められません: ${msg}`);
  process.exit(1);
};

// ---- 前提を確かめる（録り始める前に止める） ----
const has = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
if (!has("ffmpeg -hide_banner -encoders").includes("libx264")) fail("ffmpeg（libx264 つき）がありません。例: sudo apt-get install ffmpeg");
if (!has('fc-list "Noto Sans CJK JP" family')) fail("日本語のフォント Noto Sans CJK JP がありません。例: sudo apt-get install fonts-noto-cjk");
if (existsSync(DEMO_HOME) && !existsSync(join(DEMO_HOME, ".p3-video-demo")))
  fail(`${DEMO_HOME} は動画のために作ったフォルダではありません（.p3-video-demo が無い）。消さずに止めます`);
const portFree = await new Promise((res) => {
  const s = createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true)));
  s.listen(PORT);
});
if (!portFree) fail(`ポート ${PORT} が使われています（動いている p3 serve を止めてください）`);
try {
  execFileSync(join(HERE, "demo-repo.sh"), { env: { ...process.env, DEMO_HOME, P3_BIN }, stdio: ["ignore", "ignore", "pipe"] });
} catch (e) {
  fail(`${DEMO_HOME} にデモの環境を作れません（作るには root などの権限が要ります）: ${String(e.stderr ?? e.message).trim()}`);
}

// ---- 録画（CDP の screencast。止めている間の時間は詰める） ----
const work = mkdtempSync(join(tmpdir(), "p3-video-"));
const FR = join(work, "frames");
mkdirSync(FR);
const frames = [];
let paused = false;
let pausedAt = 0;
let offset = 0;
const now = () => Date.now() / 1000;

let browser;
try {
  // 日本語は Noto Sans CJK JP で描く（録画のときだけの fontconfig。中国語の字形のフォントに落ちないように）
  browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: join(HERE, "fonts.conf") } });
} catch (e) {
  fail(`Chromium を起動できません。pnpm exec playwright-core install chromium-headless-shell で入れてください\n${e.message.split("\n")[0]}`);
}
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
await ctx.addInitScript({ path: join(HERE, "overlay.js") });
const page = await ctx.newPage();
page.setDefaultTimeout(15_000);
const cdp = await ctx.newCDPSession(page);
cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  if (paused) return;
  const file = join(FR, `f${String(frames.length + 1).padStart(6, "0")}.jpg`);
  writeFileSync(file, Buffer.from(data, "base64"));
  frames.push({ file, t: now() - offset });
});
const pause = () => {
  paused = true;
  pausedAt = now();
};
const resume = () => {
  offset += now() - pausedAt;
  paused = false;
};

// ---- 画面の操作（カーソルを動かしてからクリックし、字幕を重ねる） ----
let caption = null;
const cap = async (t) => {
  caption = t;
  await page.evaluate((x) => window.__cap(x), t);
};
const pointAt = async (loc) => {
  await loc.scrollIntoViewIfNeeded();
  await sleep(250);
  const box = await loc.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(([x, y]) => window.__cursor(x, y), [x, y]);
  await sleep(800);
  return [x, y];
};
const click = async (loc) => {
  const [x, y] = await pointAt(loc);
  await page.evaluate(([x, y]) => window.__clickFx(x, y), [x, y]);
  await sleep(150);
  await loc.click();
};
const scrollTo = async (loc, block = "start") => {
  await loc.evaluate((el, block) => el.scrollIntoView({ behavior: "smooth", block }), block);
  await sleep(1200);
};
const goto = async (url) => {
  await page.goto(url);
  await sleep(300);
  if (caption) await page.evaluate((x) => window.__cap(x), caption);
};

// ターミナルの場面（打って、実際に実行し、その出力を出す）
const TERM = `file://${join(HERE, "term.html")}`;
const CARD = `file://${join(HERE, "card.html")}`;
const term = {
  open: async (cwd) => {
    await goto(TERM);
    await page.evaluate((c) => (window.term.setCwd(c), window.term.start()), cwd);
  },
  cmd: (t) => page.evaluate((t) => window.term.cmd(t), t),
  out: (t) => page.evaluate((t) => window.term.out(t), t),
  cd: (c) => page.evaluate((c) => window.term.setCwd(c), c),
  prompt: () => page.evaluate(() => window.term.prompt()),
  run: async (shown, real = shown) => {
    await term.cmd(shown);
    const out = sh(real);
    if (out.trim()) await term.out(out);
    await term.prompt();
    return out;
  },
};
const card = async (html, hold) => {
  caption = null;
  await goto(CARD);
  await page.evaluate((h) => window.card(h), html);
  await sleep(hold);
};
// 画面の場面で AI が動かす CLI（右上のパネルに打ったコマンドと出力を出す）
const panel = async (cmd, real = cmd, hold = 2200) => {
  let text = "$ ";
  for (const ch of cmd) {
    text += ch;
    if (text.length % 3 === 0) await page.evaluate((t) => window.__term(t), text);
    await sleep(18);
  }
  await page.evaluate((t) => window.__term(t), text);
  await sleep(400);
  const out = sh(real, { env: { P3_ACTOR: "ai:claude" } });
  await page.evaluate((t) => window.__term(t), `${text}\n${out.trim()}`);
  await sleep(hold);
  await page.evaluate(() => window.__term(null));
};
const reload = async () => {
  await click(page.getByRole("button", { name: "再読み込み" }));
  await sleep(1500);
};

// ---- 台本 ----
const REQUEST = `経費の申請に領収書を添付できるようにしたい。今は紙の領収書を経理に回していて、申請と突き合わせる手間がかかっている。添付はスマートフォンで撮った写真でもよいことにする。

- 申請に領収書のファイル（PDF・JPEG）を添付して保存する
- 承認者が申請から領収書を開ける
- 添付のない申請は経理に回す前に警告する
`;
const RECORDS = {
  T001: "## 変えたこと\n- 申請に領収書（PDF・JPEG、10MB まで）を添付して保存する\n\n## なぜ\n- 紙の領収書と申請の突き合わせをなくすため\n",
  T002: "## 変えたこと\n- 承認の画面から申請の領収書を開けるようにした\n\n## なぜ\n- 承認者が金額と領収書を見比べられるようにするため\n",
  T003: "## 変えたこと\n- 添付のない申請は、経理に回す前に警告を出す\n\n## なぜ\n- 領収書の出し忘れを経理の前で止めるため\n",
};
const NOTES = "# expense v1.1\n\n## できるようになったこと\n- 申請に領収書（PDF・JPEG）を添付できます\n- 承認者は申請から領収書を開けます\n- 領収書のない申請は、経理に回す前に警告が出ます\n";
let rid = "";
let serve;

const scenes = [
  [
    "タイトル",
    () =>
      card(
        `<div class="logo">P³</div><h1>p3 の使い方<br>要望から始める、人と AI のタスク管理</h1>
         <p>経費精算アプリを例に、導入からリリースまでを順に見ていきます。</p>
         <p class="note">このデモでは、Preflight の評価とリリースノートの要約に Codex ではなく Mock（試し用の簡易エンジン）を使っています。</p>`,
        6500,
      ),
  ],
  [
    "① 導入",
    async () => {
      await term.open("~");
      await cap("① 導入：管理したいリポジトリの中で p3 init を実行します");
      await sleep(1200);
      await term.cmd("cd ~/src/expense");
      await term.cd("~/src/expense");
      await term.prompt();
      await term.run("ls");
      await sleep(500);
      await term.run(`p3 init --yes --agents --description "社内向けの経費精算アプリ（申請・承認・精算）"`);
      await sleep(1500);
      await cap("データはリポジトリの .p3/ に、AI 向けの使い方は AGENTS.md と\nスキル（.claude/skills・.agents/skills）に置かれます");
      await sleep(3000);
      await term.run("ls -a");
      await sleep(2500);
      await cap("p3 whoami で、どのプロジェクトを操作するかを確かめられます");
      await term.run("p3 whoami");
      await sleep(4000);
      // しばらく使ったあとの状態にする（過去の要望と v1.0 のリリース）。準備の時間は録らない
      pause();
      sh(join(HERE, "seed.sh"));
      writeFileSync(join(DEMO_HOME, "request.md"), REQUEST);
      resume();
      await card(
        `<h1>しばらく使ったあと…</h1><p>ここからは、v1.0「初回リリース」を出した後の状態で進めます。<br>（過去の要望と、次のマイルストーン v1.1 を入れてあります）</p>`,
        4500,
      );
    },
  ],
  [
    "② 要望の登録",
    async () => {
      await term.open("~/src/expense");
      await cap("② 要望を登録する：AI に頼むと、AI が p3 の CLI で要望を登録します");
      await sleep(1500);
      await term.run("cat ~/request.md");
      await sleep(2500);
      const created = await term.run(`P3_ACTOR=ai:claude p3 request new "領収書を添付できるようにする" --milestone v1.1 --body - < ~/request.md`);
      rid = /作成: (\S+)/.exec(created)?.[1] ?? "";
      if (!rid) throw new Error(`要望の ID が読めません: ${created}`);
      await sleep(2500);
      await cap("人は p3 serve でブラウザの画面を開きます");
      await term.cmd("p3 serve");
      serve = spawn("node", [P3_BIN, "serve", "--port", String(PORT)], { cwd: REPO, env: ENV });
      let log = "";
      serve.stdout.on("data", (d) => (log += d));
      serve.stderr.on("data", (d) => (log += d));
      for (let i = 0; i < 50 && !/listen/.test(log); i++) await sleep(200);
      if (!/listen/.test(log)) throw new Error(`p3 serve が起動しません: ${log}`);
      await term.out(log);
      await sleep(3000);
      await goto(`${BASE}/`);
      await cap("進捗の画面：要望がマイルストーンと日付の上に並びます");
      await sleep(3500);
      await cap("AI が登録した要望を開きます");
      await click(page.getByRole("link", { name: /領収書を添付できるようにする/ }));
      await sleep(2500);
      await cap("要望の本文・ステータス・マイルストーンを、画面からも直せます");
      await sleep(3500);
    },
  ],
  [
    "③ Preflight",
    async () => {
      const runBtn = page.getByRole("button", { name: "▶ Preflight を実行" });
      await scrollTo(runBtn, "center");
      await cap("③ Preflight：要望を評価し、タスク案に分けます（実行するのは人です）");
      await sleep(2000);
      await click(runBtn);
      await sleep(1500);
      await cap("Codex がリポジトリと過去の要望を調べて評価します\n（このデモは Mock なので、本文の箇条書きをそのまま案にしています）");
      await page.getByText("件のタスクに分割しました").first().waitFor();
      await sleep(1500);
      await scrollTo(page.getByText("実行ログ", { exact: true }));
      await sleep(2500);
      await scrollTo(page.getByText("評価", { exact: true }));
      await cap("評価：妥当性・実現可能性・リスク・確認事項が出ます");
      await sleep(3500);
      const accept = page.getByRole("button", { name: /件をタスク化/ });
      await scrollTo(accept, "end");
      await cap("タスク案：依存の順に段階ごとに並びます");
      await sleep(3000);
      await click(page.getByRole("button", { name: "内容を見る" }).first());
      await cap("案の中身（作業内容・完了条件）を確かめ、直してから採用できます");
      await sleep(4000);
      await click(page.getByRole("button", { name: "閉じる" }));
      await sleep(800);
      await click(accept);
      await sleep(1200);
      await cap("タスク化すると、依存関係と作業ブランチ付きのタスクになります");
      await sleep(3500);
    },
  ],
  [
    "④ 作業",
    async () => {
      await click(page.getByRole("link", { name: "タスクボードで見る" }));
      await sleep(1500);
      await cap("④ 作業：AI がタスクを順に進めます");
      await sleep(2500);
      await panel(`p3 move T001 doing --req ${rid}`);
      await cap("CLI での変更は、画面の「再読み込み」で取り込みます");
      await reload();
      await sleep(2500);
      await cap("作業を終えたら、成果物（PR）と変更の記録を付けて完了にします");
      writeFileSync(join(DEMO_HOME, "record.md"), RECORDS.T001);
      await panel(`p3 move T001 done --req ${rid} --output https://github.com/example/expense/pull/21 --record - < ~/record.md`, undefined, 3000);
      await reload();
      await sleep(2500);
      await cap("T002・T003 も同じように進めます");
      for (const [t, pr] of [["T002", 22], ["T003", 23]]) {
        sh(`P3_ACTOR=ai:claude p3 move ${t} doing --req ${rid}`);
        sh(`P3_ACTOR=ai:claude p3 move ${t} done --req ${rid} --output https://github.com/example/expense/pull/${pr} --record -`, { input: RECORDS[t] });
      }
      await panel(`p3 request set ${rid} status=resolved`, undefined, 2500);
      await reload();
      await cap("全部終えたら、AI は要望を「対応済」にして人に返します");
      await sleep(3500);
      await click(page.getByText("申請に領収書のファイル").first());
      await sleep(1200);
      await cap("完了したタスクには、成果物と変更の記録が残ります");
      await sleep(6000);
      await page.keyboard.press("Escape");
      await sleep(800);
    },
  ],
  [
    "⑤ 確認とリリース",
    async () => {
      await click(page.getByRole("link", { name: "概要・Preflight" }));
      await sleep(1200);
      await cap("⑤ 確認とリリース：人が確かめて「完了済」にします");
      const status = page.locator("select").filter({ has: page.locator("option", { hasText: "完了済" }) }).first();
      await scrollTo(status, "center");
      await pointAt(status);
      await sleep(600);
      await status.selectOption({ label: "完了済" });
      await sleep(2500);
      await click(page.getByRole("link", { name: "進捗" }));
      await sleep(1200);
      await click(page.getByRole("link", { name: "すべて" }));
      await cap("進捗では、マイルストーンごとに要望の進み具合と完了の時期を見られます");
      await sleep(4500);
      await click(page.getByRole("link", { name: "リリースノート" }));
      await sleep(1500);
      await cap("リリースノート：マイルストーンに入れた要望の、変更の記録からまとめます");
      await sleep(2500);
      await click(page.getByRole("link", { name: /領収書と通知/ }).or(page.getByRole("button", { name: /領収書と通知/ })).first());
      await sleep(2500);
      await click(page.getByRole("button", { name: "機能の要約を生成" }));
      await cap("「機能の要約を生成」で Codex が案を作ります（Mock は記録の1行目を並べるだけです）");
      await sleep(5000);
      const body = page.locator("textarea").last();
      await click(body);
      await body.pressSequentially(NOTES, { delay: 28 });
      await cap("案を確かめて本文を書き、保存します。保存したノートは Markdown で書き出せます");
      await sleep(1200);
      await click(page.getByRole("button", { name: "保存", exact: true }));
      await sleep(3500);
    },
  ],
  [
    "終わり",
    () =>
      card(
        `<div class="logo">P³</div><h1>要望 → Preflight → タスク → リリース</h1>
         <p>判断（Preflight の実行・タスク化・完了）は人が、作業と記録は AI が受け持ちます。</p>
         <p style="margin-top:28px"><code>pnpx @infodb/p3 init --agents</code></p>
         <p class="note">npm: @infodb/p3 ・ 導入と使い方は同梱の docs/ にあります</p>`,
        7000,
      ),
  ],
];

let code = 0;
try {
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
  for (const [name, run] of scenes) {
    console.error(`… ${String(name)}`);
    try {
      await run();
    } catch (e) {
      const shot = join(work, "failed.png");
      await page.screenshot({ path: shot }).catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      // Playwright の待ちのタイムアウトなら、何を待っていたか（ボタンの名前など）も出す
      const target = /waiting for (.+)/.exec(msg)?.[1].split("\u001b")[0];
      const why = `${msg.split("\n")[0]}${target ? `（対象: ${target}）` : ""}`;
      throw new Error(`場面「${String(name)}」で止まりました（画面の文言や操作が変わったかもしれません）: ${why}\n  その時の画面: ${shot}`, { cause: e });
    }
  }
  await cdp.send("Page.stopScreencast");
  frames.push({ file: null, t: now() - offset });

  // フレーム（変わったときだけ届く）を表示する長さつきで並べ、30fps の mp4 にする
  const list = [];
  for (let i = 0; i < frames.length - 1; i++) list.push(`file '${frames[i].file}'`, `duration ${Math.max(0.001, frames[i + 1].t - frames[i].t).toFixed(4)}`);
  list.push(`file '${frames.at(-2).file}'`);
  writeFileSync(join(work, "list.txt"), list.join("\n") + "\n");
  mkdirSync(dirname(OUT), { recursive: true });
  const vf = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=white,fps=30,format=yuv420p";
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(work, "list.txt"),
    "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", OUT]);
  console.error(`できました: ${OUT}（${(frames.at(-1).t - frames[0].t).toFixed(0)} 秒・フレーム ${frames.length - 1} 枚）`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  code = 1;
} finally {
  serve?.kill();
  await ctx.close();
  await browser.close();
  rmSync(DEMO_HOME, { recursive: true, force: true });
  if (KEEP || code) console.error(`作業のフォルダ: ${work}（${readdirSync(FR).length} 枚）`);
  else rmSync(work, { recursive: true, force: true });
}
process.exit(code);
