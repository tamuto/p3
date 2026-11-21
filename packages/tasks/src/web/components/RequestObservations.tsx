import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Alert, Button, Empty, Loading, linkCls, Section } from "@infodb/p3-shared/web/ui.tsx";
import { api } from "../lib/api.ts";

const KIND_LABEL = { created: "作成", expected: "期待の変更", ended: "終了" } as const;
type Result = Awaited<ReturnType<typeof api.requestObservations>>;

/**
 * 要望の詳細の「この要望で扱った観測」。観測の履歴の逆引き（アプリの索引）を、要望の本体とは別に後から読む（本体の表示を待たせない）。
 * 読み込み中・無い・読めない（もう一度読む）を分けて出す。tick（データの変更の知らせ）で読み直す
 */
export function RequestObservations({ requestId, tick }: { requestId: string; tick: number }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ok"; value: Result } | { kind: "error"; message: string }>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    api.requestObservations(requestId).then(
      (value) => alive && setState({ kind: "ok", value }),
      (e: Error) => alive && setState({ kind: "error", message: e.message }),
    );
    return () => {
      alive = false;
    };
  }, [requestId, tick, retry]);
  return (
    <Section title="この要望で扱った観測">
      {state.kind === "loading" && <Loading>観測を読み込んでいます…</Loading>}
      {state.kind === "error" && (
        <Alert>
          観測を読めませんでした: {state.message} <Button onClick={() => (setState({ kind: "loading" }), setRetry((r) => r + 1))}>もう一度読む</Button>
        </Alert>
      )}
      {state.kind === "ok" && (
        <>
          {state.value.observations.length === 0 ? (
            !state.value.results?.length && <Empty>この要望の作業で作った・期待を変えた・終えた観測はありません。</Empty>
          ) : (
            <ul className="list-disc space-y-1 pl-6">
              {state.value.observations.map((o) => (
                <li key={o.id}>
                  <Link to="/observer/$id" params={{ id: o.id }} className={linkCls}>
                    {o.title}
                  </Link>
                  （{o.kinds.map((k) => KIND_LABEL[k]).join("・")}
                  {o.ended ? "・終了済み" : ""}）
                </li>
              ))}
            </ul>
          )}
          {state.value.results?.map((r) => (
            <p key={r.result}>
              この要望は観測の結果から作りました:{" "}
              <Link to="/observer/$id/runs/$rid" params={{ id: r.observation, rid: r.result }} className={linkCls}>
                {r.title ?? r.observation} の結果 {r.result}
              </Link>
            </p>
          ))}
          {state.value.unreadable > 0 && <Alert warn>読めない観測のファイルが {state.value.unreadable} 件あり、その中の履歴は数えていません。</Alert>}
        </>
      )}
    </Section>
  );
}
