import { existsSync } from "node:fs";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { Relation, Request, Task } from "../../shared/types.ts";
import { Workspace } from "../store/workspace.ts";

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};
const rel = (type: Relation["type"], target: string, extra: Partial<Relation> = {}): Relation => ({ type, target, ...extra });

/**
 * デモ用データ。題材は pcube 自身の開発（areas が実在のパスなので、Codex の preflight がそのまま試せる）。
 * データディレクトリは pcube リポジトリ内に置き、repo: ".." でリポジトリルートを指す。
 */
export async function seedDemo(dir: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "project.yaml"),
    YAML.stringify({
      name: "pcube (demo)",
      description: "ファイルベースのプロジェクト管理ツール pcube 自身の開発。TypeScript / React / Hono、preflight に Codex を使う。",
      repo: "..",
      docs: ["README.md", "docs", "TODO.md"],
      members: [
        { id: "tamuto", name: "Tamuto", email: "mutomob@gmail.com", role: "owner" },
        { id: "claude", name: "Claude", role: "developer", kind: "ai" },
      ],
      branchPattern: "req/{id}-{slug}",
      worktreeDir: ".worktrees",
      statuses: [
        { id: "backlog", label: "Backlog" },
        { id: "ready", label: "Ready" },
        { id: "in_progress", label: "In Progress" },
        { id: "review", label: "Review" },
        { id: "done", label: "Done", done: true },
      ],
      preflight: { instructions: "依存パッケージの追加は最小限に。ファイルが唯一の正である前提を崩さないこと。" },
    }),
  );
  const ws = new Workspace(dir);
  await ws.load();

  const req = (r: Partial<Request> & { title: string; body: string }) =>
    ws.requests.create({ status: "draft", areas: [], relations: [], ...r }, "seed");
  const task = (t: Partial<Task> & { title: string }) =>
    ws.tasks.create({ status: "backlog", labels: [], areas: [], relations: [], body: "", ...t }, "seed");

  await req({
    title: "ファイルベースのタスクストア",
    status: "accepted",
    areas: ["src/server/store"],
    workstream: { branch: "req/REQ-0001-file-store", worktree: ".worktrees/REQ-0001" },
    body: "DB を使わず 1タスク=1ファイル で管理したい。AI や人がファイルを直接編集しても整合が取れること。",
  });
  await req({
    title: "かんばんとガントチャート表示",
    status: "accepted",
    areas: ["src/web/routes", "src/shared/schedule.ts"],
    workstream: { branch: "req/REQ-0002-kanban-gantt", worktree: ".worktrees/REQ-0002" },
    body: "まずはかんばんで運用し、依存関係を踏まえたガントチャートでスケジュールも見たい。",
  });
  await req({
    title: "AI エージェント向け API",
    status: "accepted",
    areas: ["src/server/api"],
    workstream: { branch: "req/REQ-0003-ai-api", worktree: ".worktrees/REQ-0003" },
    relations: [rel("depends_on", "REQ-0001", { note: "ストアの楽観ロックが前提" })],
    body: "AI がタスクを自然文で特定し、状態を更新できる API。同時編集で人の変更を上書きしないこと。",
  });
  await req({
    title: "pcube を MCP サーバとして公開する",
    areas: ["src/server/api"],
    body: `Claude Code や Codex から pcube のタスクを直接操作できるよう、MCP サーバとして公開したい。

- 既存の REST API (/api/ai/manifest) と同じ操作を MCP の tool として提供する
- stdio と Streamable HTTP の両方に対応する
- 変更者 (actor) を MCP クライアント名から自動で付与する
- 楽観ロックの競合時は最新状態を返して再試行を促す`,
  });
  await req({
    title: "埋め込みベクトルによる関連検索",
    areas: ["src/server/intel"],
    body: `llmcs の embedding-server (bge-m3, OpenAI 互換 /v1/embeddings) を使い、
TF-IDF より精度の高い関連タスク検索を行いたい。サーバが無い環境では TF-IDF にフォールバックする。`,
  });

  await task({ title: "frontmatter パーサと書き出し", status: "done", request: "REQ-0001", areas: ["src/server/store"], estimate: 1, start: day(-14), due: day(-13), progress: 100, labels: ["store"], body: "YAML frontmatter + Markdown 本文の読み書き。" });
  await task({ title: "Markdown コレクションと楽観ロック", status: "done", request: "REQ-0001", areas: ["src/server/store"], estimate: 2, start: day(-12), due: day(-10), progress: 100, labels: ["store"], relations: [rel("depends_on", "TASK-0001")], body: "rev による楽観ロック、tmp→rename の原子的書き込み、ID の排他採番。" });
  await task({ title: "ファイル監視で外部編集を取り込む", status: "in_progress", request: "REQ-0001", areas: ["src/server/store/workspace.ts"], estimate: 2, start: day(-3), progress: 50, labels: ["store"], assignee: "tamuto", relations: [rel("depends_on", "TASK-0002"), rel("impacts", "TASK-0007", { origin: "ai", confidence: 0.6, note: "外部編集時に resolve の結果が変わる" })], body: "AI やエディタがファイルを直接変更したら SSE で画面に反映する。" });
  await task({ title: "かんばんボード", status: "review", request: "REQ-0002", areas: ["src/web/routes/board.tsx"], estimate: 2, start: day(-6), due: day(-3), progress: 90, labels: ["ui"], body: "ドラッグ&ドロップで列移動。" });
  await task({ title: "依存ベースの自動スケジュール", status: "ready", request: "REQ-0002", areas: ["src/shared/schedule.ts"], estimate: 1.5, labels: ["ui", "schedule"], relations: [rel("depends_on", "TASK-0002")], body: "日付未設定のタスクを、depends_on と見積りから前詰めで配置する。" });
  await task({ title: "ガントチャート表示", status: "in_progress", request: "REQ-0002", areas: ["src/web/routes/schedule.tsx"], estimate: 3, start: day(-1), labels: ["ui", "schedule"], assignee: "claude", relations: [rel("depends_on", "TASK-0005"), rel("relates_to", "TASK-0004")], body: "依存の矢印と今日線を描く。" });
  await task({ title: "自然文でタスクを特定する resolve API", status: "ready", request: "REQ-0003", areas: ["src/server/api", "src/server/intel"], estimate: 1, labels: ["ai"], relations: [rel("depends_on", "TASK-0002")], body: "ID 完全一致 → タイトル部分一致 → 内容類似 の順で候補を返す。" });
  await task({ title: "競合時に 409 と最新状態を返す", status: "backlog", request: "REQ-0003", areas: ["src/server/api"], estimate: 0.5, labels: ["ai"], relations: [rel("depends_on", "TASK-0002"), rel("relates_to", "TASK-0007")], body: "AI が古い rev で更新しようとしたら拒否して最新を返す。" });
}

// npm run demo:reset
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = resolve(process.env.PCUBE_DATA_DIR ?? ".pcube-demo");
  if (existsSync(dir)) {
    if (!process.argv.includes("--force")) throw new Error(`${dir} は既にあります (--force で作り直し)`);
    await rm(dir, { recursive: true });
  }
  await seedDemo(dir);
  console.log(`seeded ${dir}`);
}
