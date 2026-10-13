import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { chatgptCommand } from "../src/cli/chatgpt.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { chatgptView } from "../src/web/lib/chatgpt.ts";
import { loadConnection, OPENAI_ENDPOINTS, PLAN_SCOPE, SCOPES, type ChatGptAccount, type OAuthDeps } from "@infodb/chatgpt-plan";
import { chatgptAccount, ChatGptAuthError, CODEX_TOKEN_MIN_VALID_MS, signInFailure } from "../src/core/chatgpt.ts";
import { loadUserConfig, saveUserConfig } from "../src/core/userConfig.ts";
import { makeProject, tempDir, writeConnection } from "./helpers.ts";

const KID = "k1";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwt(claims: Record<string, unknown>, key: KeyObject = keys.privateKey, kid = KID) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "RS256", kid })}.${enc(claims)}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key).toString("base64url")}`;
}

/**
 * 偽の auth.openai.com。トークンの発行・更新・取り消しと JWKS を返し、受けた要求を記録する。
 * opts で ID トークンや応答を崩して、検証や失敗の扱いを確かめる。
 */
let fakes = 0;
function fakeOAuth() {
  // 部品は JWKS を URL ごとに覚えるので、偽ごとに URL を変えて取り直させる
  const endpoints = { ...OPENAI_ENDPOINTS, jwks: `${OPENAI_ENDPOINTS.jwks}?fake=${++fakes}` };
  let now = Date.parse("2026-10-10T00:00:00Z");
  const calls: { url: string; body: Record<string, string> }[] = [];
  const st = {
    clientId: "oaiapp_1",
    sub: "user-1",
    email: "a@example.com",
    scope: SCOPES.join(" "),
    idKey: keys.privateKey,
    aud: undefined as string | undefined,
    nonce: undefined as string | undefined, // 認可の nonce をそのまま返すなら undefined
    refreshError: undefined as string | undefined,
    revokeFails: false,
    serial: 0,
    lastNonce: "",
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    calls.push({ url, body });
    if (url === endpoints.jwks) return json(200, { keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] });
    if (url === OPENAI_ENDPOINTS.revoke) return st.revokeFails ? json(503, {}) : new Response("", { status: 200 });
    if (url === OPENAI_ENDPOINTS.token) {
      if (body.grant_type === "refresh_token" && st.refreshError) return json(400, { error: st.refreshError });
      st.serial++;
      const id = jwt({ iss: "https://auth.openai.com", aud: st.aud ?? st.clientId, sub: st.sub, email: st.email, nonce: st.nonce ?? st.lastNonce, exp: Math.floor(now / 1000) + 3600 }, st.idKey);
      return json(200, { access_token: `at-${st.serial}`, refresh_token: `rt-${st.serial}`, id_token: id, token_type: "Bearer", expires_in: 3600, scope: st.scope });
    }
    return json(404, {});
  }) as typeof globalThis.fetch;
  const deps: OAuthDeps = { endpoints, fetch, now: () => now };
  return { st, calls, deps, advance: (ms: number) => (now += ms) };
}

let dir = "";
let file = "";
beforeEach(() => {
  dir = tempDir("p3-chatgpt-");
  file = join(dir, "chatgpt.json");
});

/** ブラウザの代わり: authorize の URL から state・nonce を読み、コールバックを呼ぶ */
async function signIn(account: ChatGptAccount, f: ReturnType<typeof fakeOAuth>, q: Record<string, string> = {}) {
  const attempt = await account.startLogin({ port: 0 });
  const auth = new URL(attempt.url);
  f.st.lastNonce = auth.searchParams.get("nonce")!;
  const cb = new URL(attempt.redirectUri);
  cb.search = new URLSearchParams({ code: "c1", state: auth.searchParams.get("state")!, client_id: f.st.clientId, scope: f.st.scope, ...q }).toString();
  const res = await fetch(cb);
  return { attempt, auth, res, result: attempt.done.then((s) => ({ ok: true as const, s }), (e: Error) => ({ ok: false as const, e })) };
}

describe("Sign in with ChatGPT: サインイン", () => {
  it("初回は dynamic_agent_client で登録し、PKCE で換えた ID トークンを検証して 0600 で保存する", async () => {
    const f = fakeOAuth();
    const account = chatgptAccount(file, f.deps);
    const { auth, res, result } = await signIn(account, f);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("P3 に戻ってください");
    const r = await result;
    expect(r.ok && r.s).toMatchObject({ connected: true, planAllowed: true, email: "a@example.com", registered: true });

    const p = auth.searchParams;
    expect(p.get("client_id")).toBe("dynamic_agent_client");
    expect(p.get("agent_name_hint")).toBe("infodb_p3");
    expect(p.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect(p.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(p.get("scope")!.split(" ")).toEqual(expect.arrayContaining(["offline_access", PLAN_SCOPE]));
    expect(p.get("resource")).toBe("https://api.openai.com/v1");
    const exchange = f.calls.find((c) => c.body.grant_type === "authorization_code")!.body;
    expect(createHash("sha256").update(exchange.code_verifier).digest("base64url")).toBe(p.get("code_challenge"));
    expect(exchange).toMatchObject({ client_id: "oaiapp_1", redirect_uri: p.get("redirect_uri"), resource: "https://api.openai.com/v1" });

    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = (await loadConnection(file))!;
    expect(saved).toMatchObject({ clientId: "oaiapp_1", account: { sub: "user-1", email: "a@example.com" }, tokens: { accessToken: "at-1", refreshToken: "rt-1" } });

    // 2回目は発行された client ID と id_token_hint で（登録し直さない）。ホスト ID は同じ
    const again = await signIn(account, f);
    await again.result;
    expect(again.auth.searchParams.get("client_id")).toBe("oaiapp_1");
    expect(again.auth.searchParams.has("agent_name_hint")).toBe(false);
    expect(again.auth.searchParams.get("id_token_hint")).toBe(saved.tokens!.idToken);
    expect(again.auth.searchParams.get("ext_agent_host_id")).toBe(p.get("ext_agent_host_id"));
  });

  it("別の試行の応答（state が違う）は断って待ち続け、正しい応答で終わる", async () => {
    const f = fakeOAuth();
    const account = chatgptAccount(file, f.deps);
    const attempt = await account.startLogin({ port: 0 });
    f.st.lastNonce = new URL(attempt.url).searchParams.get("nonce")!;
    const bad = new URL(attempt.redirectUri);
    bad.search = "code=c&state=other&client_id=oaiapp_1";
    expect((await fetch(bad)).status).toBe(400);
    const good = new URL(attempt.redirectUri);
    good.search = new URLSearchParams({ code: "c", state: new URL(attempt.url).searchParams.get("state")!, client_id: "oaiapp_1" }).toString();
    expect((await fetch(good)).status).toBe(200);
    await expect(attempt.done).resolves.toMatchObject({ connected: true });
  });

  it.each([
    ["署名が違う", (f: ReturnType<typeof fakeOAuth>) => (f.st.idKey = other.privateKey), "署名"],
    ["宛先が違う", (f: ReturnType<typeof fakeOAuth>) => (f.st.aud = "oaiapp_other"), "宛先"],
    ["nonce が違う", (f: ReturnType<typeof fakeOAuth>) => (f.st.nonce = "replayed"), "nonce"],
  ])("ID トークンの%sときは保存しない（既存の接続も変えない）", async (_, spoil, msg) => {
    const f = fakeOAuth();
    const account = chatgptAccount(file, f.deps);
    await (await signIn(account, f)).result;
    const before = readFileSync(file, "utf8");
    spoil(f);
    const r = await (await signIn(account, f)).result;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.e.message).toContain(msg);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("別のアカウントでのサインインは上書きしない", async () => {
    const f = fakeOAuth();
    const account = chatgptAccount(file, f.deps);
    await (await signIn(account, f)).result;
    f.st.sub = "user-2";
    const r = await (await signIn(account, f)).result;
    expect(!r.ok && r.e.message).toContain("違うアカウント");
    // CLI では P3 のコマンドで案内する
    expect(!r.ok && signInFailure(r.e).message).toMatch(/違うアカウント.*p3 chatgpt logout --forget/);
    expect(!r.ok && signInFailure(r.e).message).not.toContain("logout({");
    expect((await loadConnection(file))?.account?.sub).toBe("user-1");
  });

  it("プランの利用が許可されなければ、接続はするが Preflight には使わない", async () => {
    const f = fakeOAuth();
    f.st.scope = "openid profile email offline_access";
    const account = chatgptAccount(file, f.deps);
    const r = await (await signIn(account, f)).result;
    expect(r.ok && r.s).toMatchObject({ connected: true, planAllowed: false });
    await expect(account.accessToken()).rejects.toMatchObject({ code: "plan_not_allowed" });
  });

  it("拒否・取消・タイムアウト。取り消した後のコールバックは届かない", async () => {
    const f = fakeOAuth();
    const account = chatgptAccount(file, f.deps);
    const denied = await signIn(account, f, { error: "access_denied" });
    const r = await denied.result;
    expect(!r.ok && r.e.message).toContain("取り消されました");

    const a = await account.startLogin({ port: 0 });
    await expect(account.startLogin({ port: 0 })).rejects.toThrow("待っています"); // 同時に1つだけ
    expect((await account.status()).pending?.url).toBe(a.url);
    a.cancel();
    await expect(a.done).rejects.toThrow("取り消しました");
    await expect(fetch(a.redirectUri)).rejects.toThrow(TypeError); // 待ち受けを閉じた（fetch failed）
    expect((await account.status()).pending).toBeUndefined();

    const t = await account.startLogin({ port: 0, timeoutMs: 30 });
    await expect(t.done).rejects.toThrow("待ちきれません");
    expect(await loadConnection(file)).toBeUndefined();
  });

  it("ブラウザが届かないときは、アドレスバーの URL を貼って続けられる", async () => {
    const f = fakeOAuth();
    const account = chatgptAccount(file, f.deps);
    const a = await account.startLogin({ port: 0 });
    const p = new URL(a.url).searchParams;
    f.st.lastNonce = p.get("nonce")!;
    await expect(a.submit("not a url")).rejects.toThrow("URL を読めません");
    const s = await a.submit(`${a.redirectUri}?code=c&state=${p.get("state")}&client_id=oaiapp_1`);
    expect(s).toMatchObject({ connected: true, planAllowed: true });
  });
});

describe("Sign in with ChatGPT: トークンの更新と解除", () => {
  async function connected() {
    const f = fakeOAuth();
    const account = chatgptAccount(file, f.deps);
    await (await signIn(account, f)).result;
    return { f, account };
  }

  it("期限が近ければ使う前に更新し、入れ替わった refresh token を保存する。同時に頼まれても更新は1回", async () => {
    const { f, account } = await connected();
    expect(await account.accessToken()).toBe("at-1");
    f.advance(30 * 60_000); // 残り 30 分 < 35 分
    const [a, b] = await Promise.all([account.accessToken(CODEX_TOKEN_MIN_VALID_MS), chatgptAccount(file, f.deps).accessToken(CODEX_TOKEN_MIN_VALID_MS)]);
    expect([a, b]).toEqual(["at-2", "at-2"]);
    const refreshes = f.calls.filter((c) => c.body.grant_type === "refresh_token");
    expect(refreshes.map((c) => c.body)).toEqual([{ grant_type: "refresh_token", client_id: "oaiapp_1", refresh_token: "rt-1", resource: "https://api.openai.com/v1" }]);
    expect((await loadConnection(file))?.tokens?.refreshToken).toBe("rt-2");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("更新できないエラーならトークンを消してサインインし直してもらう。通信の失敗では消さない", async () => {
    const { f, account } = await connected();
    f.advance(60 * 60_000);
    const down = chatgptAccount(file, { ...f.deps, fetch: async () => { throw new Error("ECONNRESET"); } });
    await expect(down.accessToken()).rejects.toMatchObject({ code: "network" });
    expect((await loadConnection(file))?.tokens).toBeDefined(); // 一時的な失敗では消さない（再起動しても同じ接続を使える）

    f.st.refreshError = "invalid_grant";
    const e = await account.accessToken().catch((x) => x);
    expect(e).toBeInstanceOf(ChatGptAuthError);
    expect(e.code).toBe("signin_required");
    const c = (await loadConnection(file))!;
    expect(c.tokens).toBeUndefined();
    expect(c).toMatchObject({ clientId: "oaiapp_1", account: { sub: "user-1" } }); // 登録とアカウントは残す
  });

  it("未接続ならサインインを案内する", async () => {
    await expect(chatgptAccount(file, fakeOAuth().deps).accessToken()).rejects.toMatchObject({ code: "not_connected" });
  });

  it("解除は refresh token を取り消してからトークンを消す。--forget で登録ごと。取り消しが通らなくてもローカルは消す", async () => {
    const { f, account } = await connected();
    const r = await account.logout();
    expect(r.revoked).toBe(true);
    expect(f.calls.find((c) => c.url === OPENAI_ENDPOINTS.revoke)?.body).toEqual({ token: "rt-1", token_type_hint: "refresh_token", client_id: "oaiapp_1" });
    expect(await loadConnection(file)).toMatchObject({ clientId: "oaiapp_1", account: { sub: "user-1" } });
    expect((await loadConnection(file))?.tokens).toBeUndefined();

    await (await signIn(account, f)).result;
    f.st.revokeFails = true;
    const failed = await account.logout({ forget: true });
    expect(failed.revoked).toBe(false);
    expect(failed.message).toContain("ChatGPT の設定で接続を切ってください");
    const c = (await loadConnection(file))!;
    expect(Object.keys(c)).toEqual(["hostId"]);
  });
});

describe("Sign in with ChatGPT: 秘密を出さない・個人設定と分ける", () => {
  it("CLI の状態にトークンを出さない。個人設定の保存で接続は消えず、その逆も同じ", async () => {
    const f = fakeOAuth();
    const account = chatgptAccount(file, f.deps);
    await (await signIn(account, f)).result;
    const s = await chatgptCommand(["status"], {}, account);
    const text = JSON.stringify(s.data) + s.text;
    expect(text).toContain("a@example.com");
    expect(text).not.toMatch(/at-1|rt-1|eyJ/);

    const cfgPath = join(dir, "config.yaml");
    await saveUserConfig({ projects: { p: { dir: "/data/p", repos: {} } }, ui: { theme: "dark" }, settings: {} }, cfgPath);
    expect((await loadConnection(file))?.tokens?.accessToken).toBe("at-1");
    const c = (await loadConnection(file))!;
    await writeConnection(file, { ...c, tokens: undefined });
    expect(await loadUserConfig(cfgPath)).toMatchObject({ projects: { p: { dir: "/data/p" } }, ui: { theme: "dark" } });
  });
});

describe("ChatGPT の API（画面から）", () => {
  async function setup() {
    const f = fakeOAuth();
    const p = await makeProject();
    const account = chatgptAccount(file, f.deps);
    const app = apiRoutes({ ...p.ctx, chatgpt: account });
    /** addr: 接続元、origin: ページの Origin（undefined なら付けない） */
    const call = async (method: string, path: string, opt: { body?: unknown; addr?: string; origin?: string | null } = {}) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const origin = opt.origin === undefined ? "http://localhost:4310" : opt.origin;
      if (origin) headers.origin = origin;
      const res = await app.request(
        path,
        { method, headers, body: opt.body === undefined ? undefined : JSON.stringify(opt.body) },
        { incoming: { socket: { remoteAddress: opt.addr ?? "127.0.0.1" } } },
      );
      const text = await res.text();
      return { status: res.status, text, body: text ? JSON.parse(text) : undefined };
    };
    return { f, account, call, p };
  }

  it("このマシンからだけ。変更はローカルのページ（Origin）からだけ", async () => {
    const { call } = await setup();
    expect((await call("GET", "/chatgpt", { addr: "192.168.1.20" })).status).toBe(403);
    expect((await call("GET", "/chatgpt", { addr: "::1" })).status).toBe(200);
    expect((await call("POST", "/chatgpt/logout", { origin: null })).status).toBe(403); // Origin が無いだけでは通さない
    expect((await call("POST", "/chatgpt/logout", { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("POST", "/chatgpt/logout", { origin: "http://rebind.example:4310" })).status).toBe(403);
    expect((await call("POST", "/chatgpt/logout", { addr: "172.18.0.1" })).status).toBe(403); // docker -p で公開した serve
    expect((await call("POST", "/chatgpt/logout", { origin: "http://localhost:5173" })).status).toBe(200); // Vite の開発サーバ
  });

  it("開始 → 待っている試行を読み直せる → コールバックで接続 → 状態にトークンを出さない → 解除", async () => {
    const { f, call } = await setup();
    const start = await call("POST", "/chatgpt/login");
    expect(start.status).toBe(201);
    expect((await call("POST", "/chatgpt/login")).status).toBe(400); // 同時に1つ
    const pending = (await call("GET", "/chatgpt")).body;
    expect(pending.pending).toMatchObject({ url: start.body.url, redirectUri: start.body.redirectUri });
    expect(pending.engine).toHaveProperty("detail"); // Preflight の状態も一緒に返す

    const auth = new URL(start.body.url).searchParams;
    f.st.lastNonce = auth.get("nonce")!;
    const cb = new URL(start.body.redirectUri);
    cb.search = new URLSearchParams({ code: "c", state: auth.get("state")!, client_id: "oaiapp_1" }).toString();
    expect((await fetch(cb)).status).toBe(200);
    const done = await call("GET", "/chatgpt");
    expect(done.body).toMatchObject({ connected: true, planAllowed: true, email: "a@example.com" });
    expect(done.body.pending).toBeUndefined();
    expect(done.text).not.toMatch(/at-1|rt-1|eyJ/);

    const out = await call("POST", "/chatgpt/logout", { body: {} });
    expect(out.body).toMatchObject({ revoked: true, status: { connected: false, registered: true } });
  });

  it("取消・貼り付け（待っていなければ 409）・プロジェクトの設定の保存とは別", async () => {
    const { f, call, p } = await setup();
    expect((await call("POST", "/chatgpt/paste", { body: { url: "http://127.0.0.1:1/auth/callback?code=x" } })).status).toBe(409);
    const start = await call("POST", "/chatgpt/login");
    const auth = new URL(start.body.url).searchParams;
    f.st.lastNonce = auth.get("nonce")!;
    const pasted = await call("POST", "/chatgpt/paste", { body: { url: `${start.body.redirectUri}?code=c&state=${auth.get("state")}&client_id=oaiapp_1` } });
    expect(pasted.body).toMatchObject({ connected: true });

    await call("POST", "/chatgpt/login");
    await call("POST", "/chatgpt/cancel");
    const after = (await call("GET", "/chatgpt")).body;
    expect(after).toMatchObject({ lastError: expect.stringContaining("取り消しました"), connected: true }); // 取り消しても既存の接続は変えない
    expect(after.pending).toBeUndefined();

    const saved = await call("PUT", "/project", { body: { ...p.ctx.ws.project, description: "変えた" } });
    expect(saved.status).toBe(200);
    expect((await loadConnection(file))?.tokens?.accessToken).toBe("at-1");
  });

  it("画面の表示: 待っている / 接続済み / プラン未許可（接続成功と混同しない）/ 切れた / 未接続", () => {
    const base = { connected: false, planAllowed: false, registered: false };
    expect(chatgptView({ ...base, pending: { url: "u", redirectUri: "r", startedAt: "", expiresAt: "" } })).toBe("pending");
    expect(chatgptView({ ...base, connected: true, planAllowed: true, registered: true })).toBe("connected");
    expect(chatgptView({ ...base, connected: true, registered: true })).toBe("no_plan");
    expect(chatgptView({ ...base, registered: true })).toBe("signin_again");
    expect(chatgptView(base)).toBe("disconnected");
  });
});
