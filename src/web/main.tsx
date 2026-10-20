import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Boot } from "./Boot.tsx";
import "./index.css";
import { themeController } from "./lib/useTheme.ts";

// 最初のスクリプト（/api/user-theme.js）が反映したテーマを引き継ぐ。失敗していれば system にする
themeController();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
