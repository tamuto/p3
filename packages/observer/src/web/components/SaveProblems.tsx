import { Alert } from "@infodb/p3-shared/web/ui.tsx";
import type { DefinitionProblem } from "../../shared/definition.ts";

/** 保存できなかった理由と項目ごとの誤りの一覧（観測と準備の入力で共通。項目の横にも同じ誤りを出す） */
export function SaveProblems({ problems, error }: { problems: DefinitionProblem[]; error?: { message: string; conflict?: { rev: number } } }) {
  if (!problems.length && !error) return null;
  return (
    <Alert box className="space-y-1">
      {error && <p>保存できませんでした: {error.message}</p>}
      {error?.conflict && <p>入力は残しています。ページを読み直すと今の版（{error.conflict.rev}）を開けます。</p>}
      {problems.length > 0 && (
        <ul className="list-disc pl-5">
          {problems.map((p) => (
            <li key={`${p.path}:${p.message}`}>
              {p.path || "全体"}: {p.message}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}
