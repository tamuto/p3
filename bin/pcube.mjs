#!/usr/bin/env node
// pcube CLI の起動口。TypeScript のソースを tsx でそのまま動かす（ビルド不要）。
import { register } from "tsx/esm/api";

register();
await import("../src/cli/main.ts");
