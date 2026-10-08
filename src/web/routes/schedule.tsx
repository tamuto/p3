import { createFileRoute } from "@tanstack/react-router";
import { useAppCtx } from "../lib/appCtx.ts";
import { Gantt } from "../views/Gantt.tsx";

export const Route = createFileRoute("/schedule")({
  component: () => <Gantt ctx={useAppCtx()} />,
});
