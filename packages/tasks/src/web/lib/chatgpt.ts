import type { ChatGptState } from "./api.ts";

/** 公式の UI/UX ガイドラインの表記（developers.openai.com/siwc/ui-ux-guidelines） */
export const CHATGPT_UI = {
  heading: "Use your ChatGPT plan",
  button: "Continue with ChatGPT",
  active: "Using ChatGPT plan",
  manageUsage: "Manage usage",
  usageUrl: "https://chatgpt.com/settings/usage",
  firstTitle: "You’re using your ChatGPT plan",
  gotIt: "Got it",
  limitTitle: "Usage limit reached",
} as const;

export type ChatGptView = "pending" | "connected" | "no_plan" | "signin_again" | "disconnected";

/** 状態から、設定画面のどの表示にするか（プラン利用の同意が無いのを接続成功と混同しない） */
export function chatgptView(s: Pick<ChatGptState, "connected" | "planAllowed" | "registered" | "pending">): ChatGptView {
  if (s.pending) return "pending";
  if (s.connected) return s.planAllowed ? "connected" : "no_plan";
  return s.registered ? "signin_again" : "disconnected";
}

/** 初回の説明（一度だけ出す）を出したかの記録。ブラウザごとの便利機能なので、読めなくても動く */
const SEEN_KEY = "p3.chatgpt.firstNoticeSeen";
export function firstNoticeSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}
export function markFirstNoticeSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // 保存できなくても困らない
  }
}
