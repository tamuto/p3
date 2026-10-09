import { RELATION_TYPES } from "../../shared/types.ts";

/**
 * 自己記述。GET /api/ai/manifest
 * この REST API はローカルの画面のためのもので、AI エージェントには CLI を使わせる。
 */
export const AI_MANIFEST = {
  name: "pcube",
  description:
    "1リポジトリ=1プロジェクトのファイルベースのタスク管理。作業の単位は要望で、要望ごとにフォルダを分ける" +
    "（.pcube/requests/<要望ID>/request.md, tasks/T001.md, preflight/）。" +
    "AI エージェントは `pcube` CLI（`pcube help`、`--json` 出力）を使うこと。要望の作業ツリーの中で実行すると、その要望が対象になる。",
  refs: {
    request: "<要望ID>（例: 261009-k7m3x）",
    task: "<要望ID>/T003。同じ要望の中なら T003",
  },
  relationTypes: RELATION_TYPES,
  endpoints: [
    { method: "GET", path: "/api/project", desc: "プロジェクト設定" },
    { method: "GET", path: "/api/requests", desc: "要望の一覧と進捗" },
    { method: "POST", path: "/api/requests", desc: "要望の作成" },
    { method: "GET", path: "/api/requests/:rid", desc: "要望・タスク・Preflight・関係" },
    { method: "GET|POST", path: "/api/requests/:rid/tasks", desc: "要望のタスク" },
    { method: "GET|PATCH|DELETE", path: "/api/requests/:rid/tasks/:tid", desc: "タスク（PATCH は rev で楽観ロック、null で項目を消す）" },
    { method: "POST|DELETE", path: "/api/requests/:rid[/tasks/:tid]/relations", desc: "関係の追加・削除" },
    { method: "POST", path: "/api/requests/:rid/preflight", desc: "Preflight の実行 {engine?: codex|mock, note?: メモ}。前回の結果とまだ渡していないメモを引き継ぐ" },
    { method: "GET|POST", path: "/api/requests/:rid/notes", desc: "Preflight へのメモ（GET は渡し済みか・次に引き継ぐ前回の run も返す。POST {body}）" },
    { method: "POST", path: "/api/requests/:rid/preflight/:run/materialize", desc: "採用したタスク案をタスク化" },
    { method: "GET", path: "/api/resolve?q=&request=", desc: "参照・タイトル・自然文から対象を特定" },
    { method: "GET", path: "/api/events", desc: "変更通知 (SSE)" },
  ],
};
