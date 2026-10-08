import { createFileRoute } from "@tanstack/react-router";

/** /preflight: 要望を選ぶ前の説明 */
export const Route = createFileRoute("/preflight/")({
  component: Intro,
});

function Intro() {
  const steps = [
    ["要望を書く", "やりたいことを自由に記述。1要望 = 1作業ツリー（ブランチ）になります。"],
    ["文脈を選ぶ", "インテリジェンス層が、内容・影響領域・関係グラフから関係しそうな過去/現在の仕事を絞り込みます。"],
    ["Codex が評価", "コンテナ内の Codex がリポジトリを読み、妥当性・実現可能性・影響を評価してファイルに書き出します。"],
    ["案を直してタスク化", "タスク案（1案 = 1ファイル）を取捨選択・編集し、依存関係ごとタスクとして登録します。"],
  ];
  return (
    <div className="mx-auto max-w-3xl p-10">
      <h1 className="text-2xl font-bold">Preflight</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-400">着手する前に、要望を検証し、実行可能なタスクへ分解します。左から要望を選ぶか、新しく作成してください。</p>
      <ol className="mt-8 grid gap-4 sm:grid-cols-2">
        {steps.map(([t, d], i) => (
          <li key={t} className="rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <div className="flex items-center gap-2 font-semibold">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-sm text-white">{i + 1}</span>
              {t}
            </div>
            <p className="mt-2 text-slate-600 dark:text-slate-400">{d}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
