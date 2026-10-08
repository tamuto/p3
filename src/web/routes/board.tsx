import { createFileRoute } from "@tanstack/react-router";
import { useAppCtx } from "../lib/appCtx.ts";
import { Kanban } from "../views/Kanban.tsx";

export const Route = createFileRoute("/board")({
  component: () => <Kanban ctx={useAppCtx()} />,
});
