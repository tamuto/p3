import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { themeScript } from "../src/server/api/userThemeRoutes.ts";
import { THEMES, type Theme } from "../src/shared/types.ts";
import { applyTheme, createThemeController, initialTheme, type MediaQuery, type ThemeRoot } from "../src/web/lib/theme.ts";
import { makeProject, tempDir } from "./helpers.ts";

/** html 要素の代わり（data-theme・class・color-scheme だけ） */
function fakeRoot(theme?: string) {
  const classes = new Set<string>();
  const root: ThemeRoot & { classes: Set<string> } = {
    dataset: theme === undefined ? {} : { theme },
    classList: { toggle: (n: string, force?: boolean) => (force ?? !classes.has(n) ? classes.add(n) : classes.delete(n)) },
    style: { colorScheme: "" },
    classes,
  };
  return root;
}
const state = (r: ReturnType<typeof fakeRoot>) => ({ theme: r.dataset.theme, dark: r.classes.has("dark"), colorScheme: r.style.colorScheme });

/** (prefers-color-scheme: dark) の代わり。flip で OS の明暗を変える */
function fakeMedia(matches: boolean) {
  const ls = new Set<(e: { matches: boolean }) => void>();
  const m: MediaQuery & { flip(v: boolean): void; count(): number } = {
    matches,
    addEventListener: (_t, l) => ls.add(l),
    removeEventListener: (_t, l) => ls.delete(l),
    flip(v) {
      m.matches = v;
      for (const l of ls) l({ matches: v });
    },
    count: () => ls.size,
  };
  return m;
}

const expected = (theme: Theme, osDark: boolean) => {
  const dark = theme === "dark" || (theme === "system" && osDark);
  return { theme, dark, colorScheme: dark ? "dark" : "light" };
};

describe("テーマの反映（画面）", () => {
  it("3つのテーマ × OS の明暗の6通り", () => {
    for (const t of THEMES) {
      for (const os of [false, true]) {
        const r = fakeRoot();
        applyTheme(r, t, os);
        expect(state(r), `${t} / OS ${os ? "dark" : "light"}`).toEqual(expected(t, os));
      }
    }
  });

  it("system の間だけ OS の変化に追従し、固定のテーマでは追従しない。購読は重ならず、止めれば外れる", () => {
    const media = fakeMedia(false);
    const r = fakeRoot("system");
    const c = createThemeController(r, media);
    expect(state(r)).toEqual(expected("system", false));
    media.flip(true);
    expect(state(r)).toEqual(expected("system", true));
    expect(media.count()).toBe(1);

    c.set("light");
    expect(media.count()).toBe(0);
    media.flip(false);
    media.flip(true);
    expect(state(r)).toEqual(expected("light", true)); // OS が暗くても明るいまま

    c.set("system");
    c.set("system"); // 同じ値をもう一度（StrictMode などで2回呼ばれても購読は1つ）
    expect(media.count()).toBe(1);
    expect(state(r)).toEqual(expected("system", true));
    c.stop();
    expect(media.count()).toBe(0);
  });

  it("最初のスクリプトの値を引き継ぎ、読めなければ system にする。変更を知らせる", () => {
    expect(initialTheme(fakeRoot("dark"))).toBe("dark");
    expect(initialTheme(fakeRoot("purple"))).toBe("system");
    expect(initialTheme(fakeRoot())).toBe("system"); // スクリプトが失敗した
    const r = fakeRoot();
    const c = createThemeController(r, undefined); // matchMedia が無い環境
    expect(state(r)).toEqual(expected("system", false));
    let n = 0;
    const off = c.subscribe(() => n++);
    c.set("dark");
    off();
    c.set("light");
    expect([n, c.get()]).toEqual([1, "light"]);
  });
});

describe("最初の描画の前のスクリプト（/api/user-theme.js）", () => {
  /** ブラウザの代わりにスクリプトを動かし、html 要素の状態を返す */
  const runScript = (code: string, osDark: boolean | "error") => {
    const root = fakeRoot();
    const window = {
      matchMedia: () => {
        if (osDark === "error") throw new Error("no matchMedia");
        return { matches: osDark };
      },
    };
    runInNewContext(code, { document: { documentElement: root }, window });
    return state(root);
  };

  it("画面と同じ規則で6通りを反映し、matchMedia が使えなければ明るいとみなす", () => {
    for (const t of THEMES) for (const os of [false, true]) expect(runScript(themeScript(t), os)).toEqual(expected(t, os));
    expect(runScript(themeScript("system"), "error")).toEqual(expected("system", false));
    expect(runScript(themeScript("system", "読めません */ alert(1) /*"), false)).toEqual(expected("system", false)); // コメントを閉じさせない
  });

  describe("API", () => {
    let keep: string | undefined;
    let home = "";
    beforeEach(() => {
      keep = process.env.XDG_CONFIG_HOME;
      home = tempDir("p3-theme-js-");
      process.env.XDG_CONFIG_HOME = home;
      mkdirSync(join(home, "infodb-p3"), { recursive: true });
    });
    afterEach(() => {
      if (keep === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = keep;
    });
    const write = (text: string) => writeFileSync(join(home, "infodb-p3", "config.yaml"), text);

    it("テーマだけを埋め込み、キャッシュさせず、毎回ファイルを読み直す。読めなければ system で起動させる", async () => {
      const app = apiRoutes((await makeProject()).ctx);
      const get = async () => {
        const res = await app.request("/user-theme.js", {}, { incoming: { socket: { remoteAddress: "192.168.1.20" } } });
        return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), body: await res.text() };
      };
      write("projects:\n  secret: { dir: /data/secret }\nui:\n  theme: dark\ncodex:\n  authVolume: my-volume\n");
      const r = await get();
      expect(r).toMatchObject({ status: 200, type: expect.stringContaining("javascript"), cache: "no-store" });
      expect(runScript(r.body, false)).toEqual(expected("dark", false));
      expect(r.body).not.toMatch(/secret|my-volume|projects/);

      write("ui:\n  theme: light\n");
      expect(runScript((await get()).body, true)).toEqual(expected("light", true));

      write("ui: [\n");
      const broken = await get();
      expect(broken.status).toBe(200);
      expect(broken.body).toContain("個人設定のテーマを読めませんでした");
      expect(runScript(broken.body, true)).toEqual(expected("system", true));
    });
  });
});
