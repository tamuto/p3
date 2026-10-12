import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkHtml, diagnoseRender, RENDER_IMAGE_DIR, RENDER_LIMITS, renderArgs, renderHtml, renderImageTag } from "../src/server/preflight/render.ts";
import { tempDir } from "./helpers.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-render-docker.mjs", import.meta.url));

async function fakeDocker(mode = "ok") {
  const dir = tempDir();
  const log = join(dir, "docker.log");
  const docker = join(dir, "docker");
  writeFileSync(docker, `#!/bin/sh\nFAKE_DOCKER_MODE=${mode} FAKE_DOCKER_LOG=${log} exec "${process.execPath}" "${FAKE}" "$@"\n`);
  await chmod(docker, 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
  return { docker, calls, work: tempDir() };
}

const PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>body{font-family:sans-serif} .logo{background:url(data:image/png;base64,iVBORw0KGgo=)}</style></head>
<body><h1>要望一覧</h1><a href="#list">一覧へ</a><img src="data:image/svg+xml;base64,PHN2Zy8+" alt=""><table id="list"><tr><td>A</td></tr></table></body></html>`;

describe("原稿の確かめ", () => {
  it("自己完結した HTML / CSS（data: の画像・#id）は通す", () => {
    expect(checkHtml(PAGE)).toEqual([]);
    expect(checkHtml(`<style>@font-face{font-family:x;src:url("data:font/woff2;base64,AAAA")}</style><img srcset="data:image/png;base64,AA 1x">`)).toEqual([]);
    // コメントの中は見ない
    expect(checkHtml(`<!-- <script>x</script> http://example.com --><p>a</p>`)).toEqual([]);
  });

  it("スクリプト・イベントの属性・外の参照・埋め込みは断る", () => {
    const cases: [string, string][] = [
      ["<script>alert(1)</script>", "スクリプト"],
      ["<SCRIPT src=x></SCRIPT>", "スクリプト"],
      [`<img src="x.png" onerror="alert(1)">`, "イベントの属性"],
      [`<a href="javascript:alert(1)">x</a>`, "javascript:"],
      [`<img src="http://example.com/a.png">`, "外のファイル・通信"],
      [`<img src="//example.com/a.png">`, "外のファイル・通信"],
      [`<img src="file:///etc/passwd">`, "外のファイル・通信"],
      [`<img src="../secret.png">`, "外のファイル・通信"],
      [`<img srcset="data:image/png;base64,AA 1x, https://e.com/b.png 2x">`, "外のファイル・通信"],
      [`<div style="background:url('https://e.com/x.png')"></div>`, "url("],
      [`<style>.a{background:url(/etc/passwd)}</style>`, "url("],
      [`<style>@import "https://e.com/a.css";</style>`, "@import"],
      [`<link rel="stylesheet" href="a.css">`, "<link>"],
      [`<iframe srcdoc="x"></iframe>`, "<iframe>"],
      [`<object data="a.pdf"></object>`, "<object>"],
      [`<base href="http://e.com/">`, "<base>"],
      [`<meta http-equiv="refresh" content="0;url=http://e.com">`, "http-equiv"],
      [`<svg><use xlink:href="http://e.com/a.svg#x"/></svg>`, "外のファイル・通信"],
      [`<img src="data:text/html;base64,PHNjcmlwdD4=">`, "外のファイル・通信"],
    ];
    for (const [html, want] of cases) expect(checkHtml(html).join("\n"), html).toContain(want);
    expect(checkHtml("a".repeat(RENDER_LIMITS.htmlBytes + 1))[0]).toContain("大きすぎます");
  });
});

describe("描画のコンテナ", () => {
  it("ネットワークなし・読むだけのルート・権限なし・上限つきで、原稿（読むだけ）と出力だけをマウントする", () => {
    const args = renderArgs({ image: "img", name: "p3-render-x", hostIn: "/h/in", hostOut: "/h/out" });
    const flag = (f: string) => args[args.indexOf(f) + 1];
    expect(flag("--network")).toBe("none");
    expect(args).toContain("--read-only");
    expect(flag("--cap-drop")).toBe("ALL");
    expect(flag("--security-opt")).toBe("no-new-privileges");
    expect(flag("--memory")).toBe(RENDER_LIMITS.memory);
    expect(flag("--pids-limit")).toBe(String(RENDER_LIMITS.pids));
    expect(args.filter((a) => a.startsWith("type=bind"))).toEqual(["type=bind,src=/h/in,dst=/in,readonly", "type=bind,src=/h/out,dst=/out"]);
    // 認証情報・Docker のソケット・リポジトリは渡さない
    expect(args.join(" ")).not.toMatch(/docker\.sock|auth\.json|\/workspace|\/data|--privileged|-v /);
    expect(args.at(-1)).toBe("img");
  });

  it("イメージの名前は Dockerfile と描画の中身で決まる（配布物に含まれる）", async () => {
    expect(await renderImageTag()).toMatch(/^infodb-p3-render:[0-9a-f]{12}$/);
    expect(readdirSync(RENDER_IMAGE_DIR).sort()).toEqual(["Dockerfile", "render.mjs"]);
    const dockerfile = readFileSync(join(RENDER_IMAGE_DIR, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/playwright@\d+\.\d+\.\d+/);
    expect(dockerfile).toContain("fonts-noto-cjk");
    expect(dockerfile).toMatch(/^USER render$/m);
  });

  it("確かめた原稿だけを描画し、パスの対応でマウントし、一時のフォルダを消す", async () => {
    const { docker, calls, work } = await fakeDocker();
    const out = join(work, "ui");
    const rs = await renderHtml(
      [
        { id: "U1", html: PAGE, width: 1280 },
        { id: "U2", html: "<script>x</script>", width: 1280 },
        { id: "U3", html: PAGE, width: 100 },
      ],
      work,
      out,
      { docker, pathMap: [[work, `/HOST${work}`]] },
    );
    expect(rs.map((r) => r.ok)).toEqual([true, false, false]);
    expect(rs[0]).toMatchObject({ file: join(out, "U1.png"), blocked: ["http://example.com/a.png"] });
    expect(rs[1].error).toContain("スクリプト");
    expect(rs[2].error).toContain("幅は");
    expect(readFileSync(join(out, "U1.png")).readUInt32BE(16)).toBe(1280);
    const run = calls().find((c) => c[0] === "run")!;
    expect(run.filter((a) => a.startsWith("type=bind")).every((a) => a.includes(`src=/HOST${work}/.render-`))).toBe(true);
    // 一時のフォルダ（原稿のコピー・出力）は残さない
    expect(readdirSync(work)).toEqual(["ui"]);
    expect(readdirSync(out)).toEqual(["U1.png"]);
  });

  it("何も描画しなければ docker を呼ばない", async () => {
    const { docker, calls, work } = await fakeDocker();
    const rs = await renderHtml([{ id: "U1", html: "<script></script>", width: 800 }], work, join(work, "ui"), { docker });
    expect(rs[0].ok).toBe(false);
    expect(calls()).toEqual([]);
  });

  it("1枚の失敗はその1枚だけ。イメージが無ければ作ってから描く", async () => {
    const partial = await fakeDocker("partial");
    const rs = await renderHtml([{ id: "A", html: PAGE, width: 800 }, { id: "B", html: PAGE, width: 800 }], partial.work, join(partial.work, "ui"), { docker: partial.docker });
    expect(rs.map((r) => r.ok)).toEqual([true, false]);
    expect(rs[1].error).toBe("page crashed");

    const noimage = await fakeDocker("noimage");
    await renderHtml([{ id: "A", html: PAGE, width: 800 }], noimage.work, join(noimage.work, "ui"), { docker: noimage.docker });
    expect(noimage.calls().map((c) => c[0])).toEqual(["version", "image", "build", "run"]);
  });

  it("マウントの失敗はパスの対応の直し方を添え、一時のフォルダを消す", async () => {
    const { docker, work } = await fakeDocker("fail");
    const err = await renderHtml([{ id: "U1", html: PAGE, width: 800 }], work, join(work, "ui"), { docker }).catch((e) => e);
    expect(err.step).toBe("run");
    expect(err.message).toContain("codex.pathMap");
    expect(err.message).toContain("p3 user-config set codex.pathMap+=");
    expect(readdirSync(work)).toEqual([]);
    expect(diagnoseRender("Unable to find image 'x'", [])).toContain("p3 render --update");
  });

  it("取消ではコンテナを止めてから終わり、一時のフォルダを消す", async () => {
    const { docker, calls, work } = await fakeDocker("sleep");
    const ac = new AbortController();
    const p = renderHtml([{ id: "U1", html: PAGE, width: 800 }], work, join(work, "ui"), { docker, signal: ac.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const err = await p;
    expect(err.step).toBe("cancel");
    const name = calls().find((c) => c[0] === "run")![calls().find((c) => c[0] === "run")!.indexOf("--name") + 1];
    expect(calls()).toContainEqual(["kill", name]);
    expect(readdirSync(work)).toEqual([]);
  });

  it("時間切れでもコンテナを止めて一時のフォルダを消す", async () => {
    const { docker, calls, work } = await fakeDocker("sleep");
    const limits = RENDER_LIMITS as { baseTimeoutMs: number; perPageTimeoutMs: number };
    const saved = { ...limits };
    Object.assign(limits, { baseTimeoutMs: 200, perPageTimeoutMs: 0 });
    try {
      const err = await renderHtml([{ id: "U1", html: PAGE, width: 800 }], work, join(work, "ui"), { docker }).catch((e) => e);
      expect(err.step).toBe("timeout");
      expect(calls().some((c) => c[0] === "kill")).toBe(true);
      expect(readdirSync(work)).toEqual([]);
    } finally {
      Object.assign(limits, saved);
    }
  });

  it("結果を返さなければ失敗にする", async () => {
    const { docker, work } = await fakeDocker("noreport");
    await expect(renderHtml([{ id: "U1", html: PAGE, width: 800 }], work, join(work, "ui"), { docker })).rejects.toThrow("描画の結果が読めません");
  });
});
