import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { AppDataProvider } from "@infodb/p3-tasks/web/lib/appData.tsx";
import { pageBase } from "@infodb/p3-tasks/web/lib/scope.ts";
import { createAppRouter } from "./router.tsx";

/** 画面の本体（対象は Boot.tsx が先に決める）。tasks と observer のページは同じ外枠・同じプロジェクトで出す */
export function App() {
  const [router] = useState(() => createAppRouter(pageBase()));
  return (
    <AppDataProvider>
      <RouterProvider router={router} />
    </AppDataProvider>
  );
}
