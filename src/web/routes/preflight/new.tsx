import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAppCtx } from "../../lib/appCtx.ts";
import { NewRequest } from "../../views/Preflight.tsx";

export const Route = createFileRoute("/preflight/new")({
  component: NewRequestPage,
});

function NewRequestPage() {
  const ctx = useAppCtx();
  const navigate = useNavigate();
  return (
    <NewRequest
      onCreated={(id) => {
        ctx.reload();
        void navigate({ to: "/preflight/$requestId", params: { requestId: id } });
      }}
    />
  );
}
