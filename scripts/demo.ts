/**
 * pcube 自体の開発用のデモデータを作る（製品のコードではない）。
 *
 *   pnpm demo         .pcube-demo/ が無ければ作る（pnpm dev / pnpm start の前に自動で動く）
 *   pnpm demo:reset   作り直す
 *
 * 題材は pcube 自身の開発。areas が実在のパスなので、Codex の preflight がそのまま試せる。
 * データディレクトリは pcube リポジトリ内に置き（git 管理外）、repo: ".." でリポジトリルートを指す。
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { Workspace } from "../src/server/store/workspace.ts";
import { localToday } from "../src/shared/schedule.ts";
import { DEFAULT_STATUSES, type Relation, type Request, type Task } from "../src/shared/types.ts";

const DEMO_DIR = fileURLToPath(new URL("../.pcube-demo", import.meta.url));

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localToday(d);
};
const rel = (type: Relation["type"], target: string, extra: Partial<Relation> = {}): Relation => ({ type, target, ...extra });

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
      branchPattern: "req/{id}-{slug}",
      worktreeDir: ".worktrees",
      preflight: { instructions: "依存パッケージの追加は最小限に。ファイルが唯一の正である前提を崩さないこと。" },
    }),
  );
  const ws = new Workspace(dir);
  await ws.load();

  const req = (r: Partial<Request> & { title: string; body: string }) => ws.requests.create({ status: "draft", areas: [], relations: [], ...r }, "seed");
  const tasks = (rid: string) => (t: Partial<Task> & { title: string }) =>
    ws.tasksOf(rid).create({ status: "todo", labels: [], areas: [], outputs: [], relations: [], body: "", ...t }, "ai:claude");
  const branch = (id: string, slug: string) => ({ branch: `req/${id}-${slug}`, worktree: `.worktrees/${id}` });

  // 1. 完了した要望
  const store = await req(
    {
      title: "ファイルベースのタスクストア",
      status: "done",
      areas: ["src/server/store"],
      body: "DB を使わず 1タスク=1ファイル で管理したい。AI や人がファイルを直接編集しても整合が取れること。",
    },
  );
  await ws.requests.update(store.id, { workstream: branch(store.id, "file-store") }, { actor: "seed" });
  const s = tasks(store.id);
  await s({ title: "frontmatter パーサと書き出し", status: "done", areas: ["src/server/store"], estimate: 1, start: day(-18), due: day(-17), progress: 100, outputs: ["https://github.com/tamuto/pcube/pull/1"], body: "YAML frontmatter + Markdown 本文の読み書き。" });
  await s({ title: "Markdown コレクションと楽観ロック", status: "done", areas: ["src/server/store"], estimate: 2, start: day(-16), due: day(-14), progress: 100, outputs: ["https://github.com/tamuto/pcube/pull/2"], relations: [rel("depends_on", "T001")], body: "rev による楽観ロック、tmp→rename の原子的書き込み、排他的な採番。" });
  await s({ title: "ファイル監視で外部編集を取り込む", status: "done", areas: ["src/server/store/workspace.ts"], estimate: 2, start: day(-13), due: day(-11), progress: 100, outputs: ["https://github.com/tamuto/pcube/pull/3"], relations: [rel("depends_on", "T002")], body: "AI やエディタがファイルを直接変更したら SSE で画面に反映する。" });

  // 2. 進行中の要望
  const views = await req(
    {
      title: "かんばんとガントチャート表示",
      status: "active",
      areas: ["src/web/routes", "src/shared/schedule.ts"],
      relations: [rel("depends_on", store.id, { note: "ストアのファイル形式が前提" })],
      body: "要望ごとにかんばんで運用し、依存関係を踏まえたガントチャートでスケジュールも見たい。",
    },
  );
  await ws.requests.update(views.id, { workstream: branch(views.id, "kanban-gantt") }, { actor: "seed" });
  const v = tasks(views.id);
  await v({ title: "かんばんボード", status: "done", areas: ["src/web/routes/requests/$requestId/board.tsx"], estimate: 2, start: day(-6), due: day(-4), progress: 100, labels: ["ui"], outputs: ["https://github.com/tamuto/pcube/pull/4"], body: "ドラッグ&ドロップで列移動。" });
  await v({ title: "依存ベースの自動スケジュール", status: "doing", areas: ["src/shared/schedule.ts"], estimate: 1.5, start: day(-1), progress: 40, labels: ["schedule"], body: "日付未設定のタスクを、depends_on と見積りから前詰めで配置する。" });
  await v({ title: "ガントチャート表示", status: "todo", areas: ["src/web/routes/requests/$requestId/schedule.tsx"], estimate: 3, labels: ["ui", "schedule"], relations: [rel("depends_on", "T002"), rel("relates_to", "T001")], body: "依存の矢印と今日線を描く。" });
  await v({ title: "スケジュールの日付をドラッグで変える", status: "todo", estimate: 1, labels: ["ui"], relations: [rel("depends_on", "T003")], body: "作業中に AI が追加したタスク。" });

  // 3. 進行中の要望（別の要望に影響する）
  const api = await req(
    {
      title: "AI エージェント向けの CLI",
      status: "active",
      areas: ["src/cli"],
      relations: [rel("impacts", views.id, { origin: "preflight", confidence: 0.6, note: "画面と同じ操作を提供する" })],
      body: "AI がタスクを特定し、状態を更新できる CLI。同時編集で人の変更を上書きしないこと。",
    },
  );
  await ws.requests.update(api.id, { workstream: branch(api.id, "ai-cli") }, { actor: "seed" });
  const a = tasks(api.id);
  await a({ title: "自然文でタスクを特定する find", status: "doing", areas: ["src/cli", "src/server/intel"], estimate: 1, start: day(0), progress: 20, relations: [rel("depends_on", `${store.id}/T002`)], body: "参照の一致 → タイトル部分一致 → 内容類似 の順で候補を返す。" });
  await a({ title: "競合時に終了コード 3 で知らせる", status: "todo", areas: ["src/cli"], estimate: 0.5, relations: [rel("depends_on", "T001")], body: "古い rev で更新しようとしたら拒否する。" });

  // 4. Preflight を試すための下書き
  await req(
    {
      title: "pcube を MCP サーバとして公開する",
      areas: ["src/cli"],
      body: `Claude Code や Codex から pcube のタスクを直接操作できるよう、MCP サーバとして公開したい。

- CLI と同じ操作を MCP の tool として提供する
- stdio と Streamable HTTP の両方に対応する
- 変更者 (actor) を MCP クライアント名から自動で付与する`,
    },
  );
  await req(
    {
      title: "埋め込みベクトルによる関連検索",
      areas: ["src/server/intel"],
      body: `llmcs の embedding-server (bge-m3, OpenAI 互換 /v1/embeddings) を使い、
TF-IDF より精度の高い関連タスク検索を行いたい。サーバが無い環境では TF-IDF にフォールバックする。`,
    },
  );
}

if (existsSync(DEMO_DIR)) {
  if (!process.argv.includes("--force")) process.exit(0);
  await rm(DEMO_DIR, { recursive: true });
}
await seedDemo(DEMO_DIR);
console.log(`デモデータを作りました: ${DEMO_DIR}`);
