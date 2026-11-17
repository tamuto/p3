// UI テスト（test/ui、pnpm test:ui）の土台: Chromium が無いときだけ飛ばし、ほかの失敗は飛ばさないこと、pnpm check が最初にブラウザを確かめること、子の p3 の環境を分けること。
// 本物の Chromium は使わない（無い環境でも確かめられる）
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { describe, expect, it } from "vitest";
import { checkBrowser, DEPS_HINT, INSTALL_HINT, missingExecutable, probeChromium } from "./ui/chromium.ts";
import { childBaseEnv } from "./ui/env.ts";
import { checkBuilt, FONTCONFIG, jaFontconfig } from "./ui/globalSetup.ts";
import { tempDir } from "./helpers.ts";

describe("UI テストの Chromium の判定", () => {
  it("実行ファイルが無いときだけ飛ばす（Playwright の文言のパスが本当に無いことも確かめる）", async () => {
    const dir = tempDir();
    const none = join(dir, "chrome-headless-shell");
    expect(missingExecutable(new Error(`browserType.launch: Executable doesn't exist at ${none}\n╔═══`))).toBe(none);
    expect(missingExecutable(new Error(`Failed to launch chromium because executable doesn't exist at ${none}`))).toBe(none);
    // 文言はそうでも、パスがあるなら無いとは扱わない
    expect(missingExecutable(new Error(`Executable doesn't exist at ${dir}`))).toBeUndefined();
    expect(missingExecutable(new Error("Target page, context or browser has been closed"))).toBeUndefined();
    expect(missingExecutable("x")).toBeUndefined();

    await expect(probeChromium(() => chromium.launch({ executablePath: none }))).resolves.toEqual({
      available: false,
      reason: `Chromium（headless shell）がありません: ${none}`,
    });
  });

  it("実行ファイルがあるのに起動できないときは、飛ばさずに失敗にする", async () => {
    const dir = tempDir();
    const broken = join(dir, "chrome-headless-shell");
    writeFileSync(broken, "#!/bin/sh\necho 'error while loading shared libraries: libnss3.so' >&2\nexit 127\n");
    chmodSync(broken, 0o755);
    await expect(probeChromium(() => chromium.launch({ executablePath: broken, timeout: 10_000 }))).rejects.toThrow(/Chromium を起動できません（実行ファイルはあります/);
    await expect(probeChromium(() => Promise.reject(new Error("spawn EACCES")))).rejects.toThrow(/spawn EACCES/);
  });

  it("pnpm check は型検査より前にブラウザを確かめ、無い・起動できないなら入れ方を出して止める", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.check.split(" && ")[0]).toBe("pnpm check:browser");
    expect(pkg.scripts["check:browser"]).toBe("tsx scripts/check-browser.ts");

    const dir = tempDir();
    const none = join(dir, "chrome-headless-shell");
    const missing = await checkBrowser(() => chromium.launch({ executablePath: none }));
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.message).toContain(`入れるには: ${INSTALL_HINT}`);

    const broken = join(dir, "broken-shell");
    writeFileSync(broken, "#!/bin/sh\necho 'error while loading shared libraries: libnspr4.so' >&2\nexit 127\n");
    chmodSync(broken, 0o755);
    const deps = await checkBrowser(() => chromium.launch({ executablePath: broken, timeout: 10_000 }));
    expect(deps.ok).toBe(false);
    expect(!deps.ok && deps.message).toContain(DEPS_HINT);
    expect(!deps.ok && deps.message).toContain("libnspr4.so");

    let closed = false;
    const fake = { close: async () => void (closed = true) } as unknown as Browser;
    await expect(checkBrowser(async () => fake)).resolves.toEqual({ ok: true });
    expect(closed).toBe(true);
  });

  it("画面のビルドが無ければ、Chromium の有無によらず失敗にする", () => {
    expect(() => checkBuilt(join(tempDir(), "index.html"))).toThrow(/画面のビルドがありません.*pnpm build/);
  });
});

describe("UI テストのフォント", () => {
  it("Noto Sans CJK JP があれば動画と同じ fontconfig を使い、無ければ（fc-list も無ければ）既定のフォントのまま", () => {
    expect(jaFontconfig(() => "Noto Sans CJK JP\n")).toBe(FONTCONFIG);
    expect(FONTCONFIG).toMatch(/scripts\/fonts-ja\.conf$/);
    expect(jaFontconfig(() => "")).toBeNull();
    expect(
      jaFontconfig(() => {
        throw new Error("spawn fc-list ENOENT");
      }),
    ).toBeNull();
  });
});

describe("UI テストの子の p3 の環境", () => {
  it("親の P3_*・INIT_CWD・git と XDG の場所の指定を引き継がない", () => {
    const env = childBaseEnv({
      PATH: "/usr/bin",
      LANG: "ja_JP.UTF-8",
      P3_ACTOR: "ai:other",
      P3_PROJECT: "real",
      INIT_CWD: "/home/me/src/app",
      GIT_DIR: "/home/me/src/app/.git",
      XDG_CONFIG_HOME: "/home/me/.config",
      npm_config_user_agent: "pnpm",
    });
    expect(env).toEqual({ PATH: "/usr/bin", LANG: "ja_JP.UTF-8" });
  });
});
