import { RELATION_TYPES } from "../../shared/types.ts";

/**
 * AI エージェントが最初に読む自己記述。GET /api/ai/manifest
 * （将来 MCP サーバとして公開する際もこの定義を元にする）
 */
export const AI_MANIFEST = {
  name: "pcube",
  description:
    "1サーバ=1プロジェクトのファイルベースのタスク管理。タスクは tasks/TASK-xxxx.md、要望は requests/REQ-xxxx.md。API 経由でもファイル直接編集でも同じ状態になる。",
  conventions: {
    actor: "変更時は `X-Pcube-Actor: ai:<agent-name>` ヘッダを付ける（履歴の updatedBy に残る）",
    optimisticLock: "更新時は取得した rev を body.rev か If-Match ヘッダで送る。他者が先に更新していたら 409 と最新状態が返る",
    nullClears: "PATCH で値に null を渡すとその項目を消す",
  },
  relationTypes: RELATION_TYPES,
  workflow: [
    "1. GET /api/resolve?q=<ID・タイトル・自然文> で対象タスクを特定する（match が null なら candidates から選ぶ）",
    "2. GET /api/tasks/:id でタスクと関係グラフ(neighborhood: 明示・暗黙・影響範囲)を取得する",
    "3. PATCH /api/tasks/:id {status, progress, rev, ...} で更新する",
    "4. 関係は POST /api/tasks/:id/relations {type, target, note, confidence} で1本ずつ追加する（depends_on は循環チェックあり）",
  ],
  endpoints: [
    { method: "GET", path: "/api/project", desc: "プロジェクト設定・ステータス一覧" },
    { method: "GET", path: "/api/tasks?status=&request=&area=&q=", desc: "タスク一覧" },
    { method: "GET", path: "/api/tasks/:id", desc: "タスク + 関係グラフ" },
    { method: "POST", path: "/api/tasks", desc: "タスク作成" },
    { method: "PATCH", path: "/api/tasks/:id", desc: "タスク更新（rev で楽観ロック）" },
    { method: "DELETE", path: "/api/tasks/:id", desc: "アーカイブ（.archive/ へ移動）" },
    { method: "POST", path: "/api/tasks/:id/relations", desc: "関係を追加" },
    { method: "DELETE", path: "/api/tasks/:id/relations?type=&target=", desc: "関係を削除" },
    { method: "GET", path: "/api/resolve?q=", desc: "自然文/部分 ID からタスク・要望を特定" },
    { method: "GET", path: "/api/related?q=&areas=&seeds=", desc: "内容・領域・グラフから関連項目を検索" },
    { method: "GET", path: "/api/requests", desc: "要望一覧" },
    { method: "POST", path: "/api/requests", desc: "要望作成" },
    { method: "POST", path: "/api/requests/:id/preflight", desc: "preflight 実行 {engine?: codex|mock}" },
    { method: "GET", path: "/api/requests/:id/preflight/:run", desc: "preflight 結果" },
    { method: "POST", path: "/api/requests/:id/preflight/:run/materialize", desc: "採用したタスク案をタスク化" },
    { method: "GET", path: "/api/events", desc: "変更通知 (SSE)" },
  ],
};
