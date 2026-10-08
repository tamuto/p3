/**
 * pcube 自体の開発用のデモデータを作る（製品のコードではない）。
 *
 *   pnpm demo         .pcube-demo/ が無ければ作る（pnpm dev / pnpm start の前に自動で動く）
 *   pnpm demo:reset   作り直す
 *
 * 題材は pcube 自身の開発。要望を作り、実際に Preflight（Mock エンジン）を走らせてタスク化し、
 * 作業を進めた状態まで作る。だから評価・タスク案・かんばん・進捗の画面がそのまま確かめられる。
 * データディレクトリは pcube リポジトリ内に置き（git 管理外）、repo: ".." でリポジトリルートを指す。
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ProjectIndex } from "../src/server/intel/index.ts";
import { MockEngine } from "../src/server/preflight/mockEngine.ts";
import { PreflightService } from "../src/server/preflight/service.ts";
import { Workspace } from "../src/server/store/workspace.ts";
import { localToday } from "../src/shared/dates.ts";
import { DEFAULT_STATUSES, type Request } from "../src/shared/types.ts";

const DEMO_DIR = fileURLToPath(new URL("../.pcube-demo", import.meta.url));

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localToday(d);
};

async function seedDemo(dir: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "project.yaml"),
    YAML.stringify({
      name: "pcube (demo)",
      description: "ファイルベースのプロジェクト管理ツール pcube 自身の開発。TypeScript / React / Hono、preflight に Codex を使う。",
      repo: "..",
      docs: ["README.md", "docs", "TODO.md"],
      statuses: DEFAULT_STATUSES,
      milestones: [
        { id: "v0.1", title: "最初の試作", due: day(-10), done: true },
        { id: "v0.2", title: "要望単位の運用", due: day(12) },
        { id: "v0.3", title: "AI 連携の拡充", due: day(40) },
      ],
      branchPattern: "req/{id}-{slug}",
      worktreeDir: ".worktrees",
      preflight: { instructions: "依存パッケージの追加は最小限に。ファイルが唯一の正である前提を崩さないこと。" },
    }),
  );
  const ws = new Workspace(dir);
  await ws.load();
  const index = new ProjectIndex(ws);
  const preflight = new PreflightService(ws, index, { mock: new MockEngine({ delay: 0 }) }, "mock");

  /** 要望を作って Preflight し、タスク化する（skip したタスク案はタスクにしない） */
  async function request(r: Partial<Request> & { title: string; body: string }, opts: { materialize?: boolean; skip?: string[] } = {}) {
    const req = await ws.requests.create({ status: "draft", ...r }, "human:tamuto");
    if (opts.materialize === undefined) return req.id; // Preflight 前のまま
    const run = await preflight.start(req.id, { actor: "human:tamuto" });
    await preflight.wait(req.id, run.id);
    if (opts.materialize) {
      for (const key of opts.skip ?? []) await preflight.updateDraft(req.id, run.id, key, { include: false });
      await preflight.materialize(req.id, run.id, "human:tamuto");
    }
    index.invalidate();
    return req.id;
  }
  /** AI が作業を進める（作業中 → 完了 + 成果物） */
  const work = async (rid: string, tid: string, status: "doing" | "done", output?: string) => {
    const col = ws.tasksOf(rid);
    if (status === "done" && col.require(tid).status === "todo") await col.update(tid, { status: "doing" }, { actor: "ai:claude" });
    await col.update(tid, { status, ...(output ? { outputs: [output] } : {}) }, { actor: "ai:claude" });
  };
  const pr = (n: number) => `https://github.com/tamuto/pcube/pull/${n}`;

  // v0.1: リリース済み
  const store = await request(
    {
      title: "ファイルベースのタスクストア",
      milestone: "v0.1",
      tags: ["core"],
      due: day(-12),
      areas: ["src/server/store"],
      body: `DB を使わず 1タスク=1ファイル で管理したい。AI や人がファイルを直接編集しても整合が取れること。

- frontmatter のパーサと書き出し
- Markdown コレクションと楽観ロック
- ファイル監視で外部編集を取り込む`,
    },
    { materialize: true },
  );
  for (const [i, t] of ["T001", "T002", "T003"].entries()) await work(store, t, "done", pr(i + 1));
  await ws.requests.update(store, { status: "done" }, { actor: "human:tamuto" });

  // v0.2: 進行中
  const views = await request(
    {
      title: "要望ごとのかんばんと進捗の画面",
      milestone: "v0.2",
      tags: ["ui"],
      due: day(5),
      areas: ["src/web/routes"],
      body: `要望ごとにかんばんで運用し、要望を横断して進捗を見たい。

- かんばんボード（ドラッグで列を移動）
- 進捗の画面（要望ごとの完了率）
- タスク詳細のドロワー
- マイルストーンごとのまとめ表示`,
    },
    { materialize: true },
  );
  await work(views, "T001", "done", pr(4));
  await work(views, "T002", "done", pr(5));
  await work(views, "T003", "doing");
  // 作業中に AI が見つけて足したタスク
  await ws.tasksOf(views).create(
    { title: "完了カードに成果物のリンクを出す", body: "作業中に見つかった追加の作業。", relations: [{ type: "relates_to", target: "T001" }] },
    "ai:claude",
  );

  const cli = await request(
    {
      title: "AI エージェント向けの CLI",
      milestone: "v0.2",
      tags: ["cli", "ai"],
      due: day(-1),
      areas: ["src/cli"],
      body: `AI がタスクを特定し、状態を更新できる CLI。同時編集で人の変更を上書きしないこと。

- 自然文でタスクを特定する find
- 要望の作業ツリーから今の要望を判定する
- 競合時に終了コード 3 で知らせる`,
    },
    { materialize: true },
  );
  await work(cli, "T001", "done", pr(6));
  await work(cli, "T002", "doing");
  // 要望をまたぐ依存（CLI の find はストアの楽観ロックが前提）
  const t1 = ws.tasksOf(cli).require("T003");
  await ws.tasksOf(cli).update("T003", { relations: [...t1.relations, { type: "depends_on", target: `${store}/T002`, origin: "human" }] }, { actor: "human:tamuto" });

  // v0.3: 評価済み（タスク案のレビュー待ち）
  await request(
    {
      title: "pcube を MCP サーバとして公開する",
      milestone: "v0.3",
      tags: ["ai"],
      areas: ["src/cli"],
      body: `Claude Code や Codex から pcube のタスクを直接操作できるよう、MCP サーバとして公開したい。

- CLI と同じ操作を MCP の tool として提供する
- stdio と Streamable HTTP の両方に対応する
- 変更者 (actor) を MCP クライアント名から自動で付与する`,
    },
    { materialize: false },
  );

  // マイルストーンなし: Preflight 前の下書き
  await request({
    title: "埋め込みベクトルによる関連検索",
    tags: ["intel"],
    areas: ["src/server/intel"],
    body: `llmcs の embedding-server (bge-m3, OpenAI 互換 /v1/embeddings) を使い、
TF-IDF より精度の高い関連タスク検索を行いたい。サーバが無い環境では TF-IDF にフォールバックする。`,
  });
}

if (existsSync(DEMO_DIR)) {
  if (!process.argv.includes("--force")) process.exit(0);
  await rm(DEMO_DIR, { recursive: true });
}
await seedDemo(DEMO_DIR);
console.log(`デモデータを作りました: ${DEMO_DIR}`);
