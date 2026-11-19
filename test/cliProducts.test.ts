import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.ts";
import { CONFIG_HOME, initialized, p3, snapshot } from "./cliHelpers.ts";

/**
 * 製品ごとの CLI の呼び方（docs/architecture.md「p3-observer」）。
 *   名前空間の無いコマンドは今までどおり tasks。observer は p3 observer <サブコマンド> で、tasks のプロジェクトの解決・個人設定を経ない。
 *   併用は同じ p3 から両方を呼ぶ
 */
const VERSION = JSON.parse(readFileSync(new URL("../packages/p3/package.json", import.meta.url), "utf8")).version as string;

describe("p3 observer（tasks を経ない名前空間）", () => {
  it("tasks の登録が無い隔離した場所で、共通の版と起動状態を返し、tasks のデータ・登録・個人設定を作らない", () => {
    const cwd = tempDir("p3-observer-cwd-");
    const r = p3(cwd, ["observer", "status", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(r.json()).toEqual({ product: "observer", version: VERSION, state: "ready", dataDir: null });
    expect(r.err).toBe("");
    // 今いる場所にも個人設定の場所にも何も作らない
    expect(readdirSync(cwd)).toEqual([]);
    expect(readdirSync(CONFIG_HOME)).toEqual([]);
    // 通常の出力
    const text = p3(cwd, ["observer", "status"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`p3-observer ${VERSION}`);
    expect(text.out).toContain("state  ready");
  });

  it("個人設定が壊れていても動く（読まない）", () => {
    const cwd = tempDir("p3-observer-cwd-");
    const home = tempDir("p3-observer-broken-");
    mkdirSync(join(home, "infodb-p3"));
    writeFileSync(join(home, "infodb-p3", "config.yaml"), "projects: [壊れた\n");
    // tasks のコマンドは個人設定を読めずに止まるが、observer は読まずに動く
    expect(p3(cwd, ["whoami", "--json"], {}, home).code).not.toBe(0);
    const broken = p3(cwd, ["observer", "status", "--json"], {}, home);
    expect(broken.code, broken.err).toBe(0);
    expect(broken.json().state).toBe("ready");
  });

  it("サブコマンドの誤りは使い方の誤り（終了コード 1）で、次にすることを出す", () => {
    const cwd = tempDir("p3-observer-cwd-");
    for (const args of [["observer"], ["observer", "start"], ["observer", "status", "extra"]]) {
      const r = p3(cwd, args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toContain("p3 observer status");
    }
  });
});

describe("tasks の呼び方は変わらない（併用は同じ p3 から）", () => {
  it("同じプロジェクトで、tasks のコマンドと observer のコマンドを同じ p3 から呼べ、observer は tasks のデータを変えない", async () => {
    const { root, rid } = await initialized();
    const before = snapshot(`${root}/.p3`);
    const obs = p3(root, ["observer", "status", "--json"]);
    expect(obs.code, obs.err).toBe(0);
    expect(obs.json().version).toBe(VERSION);
    expect(snapshot(`${root}/.p3`)).toEqual(before);

    // 代表的な tasks のコマンドの出力と終了コード
    const who = p3(root, ["whoami", "--json"]);
    expect(who.code, who.err).toBe(0);
    expect(who.json()).toMatchObject({ project: expect.any(String), via: "cwd" });
    const shown = p3(root, ["request", "show", rid, "--brief", "--json"]);
    expect(shown.code).toBe(0);
    expect(shown.json().item).toMatchObject({ id: rid, title: "通知機能", status: "draft" });
    expect(p3(root, ["ls", "--req", rid, "--json"]).json()).toEqual([]);
    // 見つからない → 2、使い方の誤り → 1 も今までどおり
    expect(p3(root, ["request", "show", "999999-zzzzz", "--json"]).code).toBe(2);
    expect(p3(root, ["move"]).code).toBe(1);
  });

  it("AI 向けの入口（guide）と help は tasks の手順のまま。help に observer の呼び方が出る", () => {
    const cwd = tempDir("p3-guide-");
    const g = p3(cwd, ["guide", "--json"]);
    expect(g.code, g.err).toBe(0);
    expect(g.json()).toMatchObject({ schemaVersion: 1, entryVersion: 1, cliVersion: VERSION });
    expect(g.json().guide).toBe(readFileSync(new URL("../packages/p3/src/cli/guide.md", import.meta.url), "utf8"));
    const help = p3(cwd, ["help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("observer status");
    expect(help.out).toContain("whoami");
  });
});
