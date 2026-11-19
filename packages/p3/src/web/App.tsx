import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { AppDataProvider } from "@infodb/p3-tasks/web/lib/appData.tsx";
import { createAppRouter } from "./router.tsx";

/** 画面の本体（この画面の対象は Boot.tsx が先に決める） */
export function App() {
  const [router] = useState(createAppRouter);
  return (
    <AppDataProvider>
      <RouterProvider router={router} />
    </AppDataProvider>
  );
}
