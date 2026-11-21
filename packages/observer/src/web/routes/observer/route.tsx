import { Button } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { setWorkRef, workRef } from "../../lib/work.ts";

/**
 * 観測の画面の外枠。タスクの詳細の「この作業として観測を開く」から移ったとき（?work=<要望ID>/<T>）は作業の文脈を覚え、観測の作成・期待の変更・終了に
 * 作業の帰属を添えることを知らせる（外すまで、このタブの観測の画面で続く）
 */
export const Route = createFileRoute("/observer")({
  component: ObserverLayout,
  validateSearch: (s: Record<string, unknown>): { work?: string } => ({ work: typeof s.work === "string" ? s.work : undefined }),
});

function ObserverLayout() {
  const { work } = Route.useSearch();
  const navigate = useNavigate();
  const [ref, setRef] = useState(workRef);
  useEffect(() => {
    if (!work) return;
    setWorkRef(work);
    setRef(work);
    void navigate({ to: ".", search: (s: Record<string, unknown>) => ({ ...s, work: undefined }), replace: true });
  }, [work, navigate]);
  return (
    <>
      {ref && (
        <div role="status" className="flex flex-wrap items-center gap-3 px-4 pt-3 sm:px-6 lg:px-8">
          <p>
            作業の帰属: タスク <code>{ref}</code> の作業として、観測の作成・期待の変更・終了を履歴に残します。
          </p>
          <Button
            onClick={() => {
              setWorkRef(undefined);
              setRef(undefined);
            }}
          >
            作業の文脈を外す
          </Button>
        </div>
      )}
      <Outlet />
    </>
  );
}
