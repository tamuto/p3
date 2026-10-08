import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useAppCtx } from "../lib/appCtx.ts";
import { PreflightLayout } from "../views/Preflight.tsx";

/** /preflight 配下の共通の枠（左に要望の一覧） */
export const Route = createFileRoute("/preflight")({
  component: () => (
    <PreflightLayout ctx={useAppCtx()}>
      <Outlet />
    </PreflightLayout>
  ),
});
