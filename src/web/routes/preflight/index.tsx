import { createFileRoute } from "@tanstack/react-router";
import { Intro } from "../../views/Preflight.tsx";

export const Route = createFileRoute("/preflight/")({
  component: Intro,
});
