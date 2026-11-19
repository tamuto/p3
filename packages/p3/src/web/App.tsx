import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { AppDataProvider } from "@infodb/p3-tasks/web/lib/appData.tsx";
import { pageBase } from "@infodb/p3-tasks/web/lib/scope.ts";
import { createAppRouter } from "./router.tsx";

/**
 * 画面の本体（この画面の製品と対象は Boot.tsx が先に決める）。tasks の画面だけ AppDataProvider で tasks のデータ・設定・イベントを読む。
 * tasks を読まない画面（observer のページ）では作らない（tasks の API を要求しない）
 */
export function App({ tasks }: { tasks: boolean }) {
  const [router] = useState(() => createAppRouter(tasks ? pageBase() : "/"));
  if (!tasks) return <RouterProvider router={router} />;
  return (
    <AppDataProvider>
      <RouterProvider router={router} />
    </AppDataProvider>
  );
}
