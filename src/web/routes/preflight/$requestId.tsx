import { createFileRoute } from "@tanstack/react-router";
import { Empty } from "../../components/ui.tsx";
import { useAppCtx } from "../../lib/appCtx.ts";
import { optionalString } from "../../lib/search.ts";
import { RequestPanel } from "../../views/Preflight.tsx";

/** 要望の詳細。?run= で表示する preflight を選ぶ（省くと最新） */
export const Route = createFileRoute("/preflight/$requestId")({
  validateSearch: (s: Record<string, unknown>): { run?: string } => ({ run: optionalString(s.run) }),
  component: RequestPage,
});

function RequestPage() {
  const ctx = useAppCtx();
  const { requestId } = Route.useParams();
  const { run } = Route.useSearch();
  const navigate = Route.useNavigate();
  const request = ctx.requests.find((r) => r.id === requestId);
  if (!request) {
    return (
      <div className="p-10">
        <Empty>{requestId} は見つかりません</Empty>
      </div>
    );
  }
  return (
    <RequestPanel
      key={request.id}
      ctx={ctx}
      request={request}
      runId={run}
      onRunChange={(id) => void navigate({ search: (prev) => ({ ...prev, run: id }) })}
    />
  );
}
