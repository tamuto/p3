import { RouterProvider } from "@tanstack/react-router";
import { AppDataProvider } from "./lib/appData.tsx";
import { router } from "./router.tsx";

export function App() {
  return (
    <AppDataProvider>
      <RouterProvider router={router} />
    </AppDataProvider>
  );
}
