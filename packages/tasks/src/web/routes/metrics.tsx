import { createFileRoute } from "@tanstack/react-router";
import { MetricsPage } from "../../features/metrics/web/MetricsPage.tsx";
import { optionalString } from "../lib/search.ts";

/** 開発の指標のページ（URL の ?m= でマイルストーン。省けばプロジェクト全体）。中身は features/metrics/web/MetricsPage.tsx */
export const Route = createFileRoute("/metrics")({
  validateSearch: (s: Record<string, unknown>): { m?: string } => ({ m: optionalString(s.m) }),
  component: MetricsPage,
});
