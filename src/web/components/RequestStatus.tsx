import type { RequestStatus } from "../../shared/types.ts";
import { Badge, type Tone } from "./ui.tsx";

const STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
  draft: { label: "下書き", tone: "slate" },
  preflight: { label: "評価中", tone: "indigo" },
  reviewed: { label: "評価済み", tone: "amber" },
  accepted: { label: "タスク化済み", tone: "emerald" },
  rejected: { label: "見送り", tone: "rose" },
};

/** 要望のステータス（Preflight の一覧と詳細で使う） */
export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}
