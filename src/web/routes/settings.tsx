import { createFileRoute } from "@tanstack/react-router";
import { useAppCtx } from "../lib/appCtx.ts";
import { Settings } from "../views/Settings.tsx";

export const Route = createFileRoute("/settings")({
  component: () => <Settings ctx={useAppCtx()} />,
});
