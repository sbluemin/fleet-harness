import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProviderAuthService } from "../src/auth/index.js";
import {
  CODEX_AUTH_PROVIDER_ID,
  createCodexOAuth,
  createCursorOAuth,
  CURSOR_AUTH_PROVIDER_ID,
  createMuseCodeOAuth,
  createXaiOAuth,
  MUSE_CODE_AUTH_PROVIDER_ID,
  SUBSCRIPTION_SIGNED_OUT_ENTRY,
  XAI_AUTH_PROVIDER_ID,
} from "../src/oauth/index.js";
import { readBoundedFile, type CredentialResolverDeps } from "../src/transport/credentials.js";

function jwt(payload: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Fleet-owned Muse Code sign-in", () => {
  // 기존 CLI 자격 판독 테스트로는 로그인 수명·비밀 비노출·저장 전환을 실행할 수 없었다.
  it("persists an approved device login, keeps secrets server-side, and never saves a denied login", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muse-oauth-"));
    const authService = createProviderAuthService({ dataDir: directory });
    let denied = false;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.redirect).toBe("error");
      if (String(url).endsWith("/authorization/")) {
        expect(String(init?.body)).toBe("client_id=1031625952748946");
        return Response.json({
          device_code: "server-device-secret", user_code: "TEST-CODE",
          verification_uri: "https://auth.meta.com/device", verification_uri_complete: "https://auth.meta.com/device?code=TEST-CODE",
          expires_in: 60, interval: 1,
        });
      }
      if (String(url).endsWith("/token/")) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
        expect(form.get("device_code")).toBe("server-device-secret");
        return denied ? Response.json({ error: "access_denied" }, { status: 400 })
          : Response.json({ access_token: "server-account-secret", expires_in: 3600 });
      }
      expect(String(url)).toBe("https://api.meta.ai/muse-code/key");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer server-account-secret");
      expect(init?.body).toBe("{}");
      return Response.json({ api_key: "LLM|model-secret", base_url: "https://api.meta.ai/v1", is_subs_active: true, user_email: "private@example.com" });
    });
    const onQuota = vi.fn();
    const oauth = createMuseCodeOAuth({ authService, fetch: fetchImpl, onQuota });
    try {
      const [first, second] = await Promise.all([oauth.start(), oauth.start()]);
      expect(second).toEqual(first);
      expect(JSON.stringify(first)).not.toContain("server-device-secret");
      await vi.waitFor(() => expect(oauth.status(first.loginId)?.state).toBe("signed_in"), { timeout: 3000 });
      const entry = await authService.getEntry(MUSE_CODE_AUTH_PROVIDER_ID);
      expect(entry).toMatchObject({ key: "LLM|model-secret", type: "oauth-device", accessToken: "server-account-secret", version: 1 });
      const raw = fs.readFileSync(path.join(directory, "auth.json"), "utf8");
      expect(raw).not.toContain("private@example.com");
      if (process.platform !== "win32") expect(fs.statSync(path.join(directory, "auth.json")).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(oauth.status(first.loginId))).not.toMatch(/server-account-secret|model-secret/);
      expect(onQuota).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ok", windows: [] }));
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      // 로그인 mint의 사용량을 재사용한다. quota 패널의 첫 조회 때문에 키를 다시 발급하지 않는다.
      await oauth.fetchUsage();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      await oauth.logout();
      expect(await authService.getEntry(MUSE_CODE_AUTH_PROVIDER_ID)).toBeUndefined();
      expect(onQuota).toHaveBeenLastCalledWith({ status: "not_connected" });
      denied = true;
      const rejected = await oauth.start();
      await vi.waitFor(() => expect(oauth.status(rejected.loginId)?.state).toBe("denied"), { timeout: 3000 });
      expect(await authService.getEntry(MUSE_CODE_AUTH_PROVIDER_ID)).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(5);
    } finally {
      oauth.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Fleet-owned subscription sign-in", () => {
  // Codex는 RFC 8628이 아니다. 승인 뒤 서버가 준 code·verifier로 교환하고, 계정 id는 토큰에서 꺼낸다.
  it("signs in to Codex through device auth and stores only the Console entry", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-oauth-"));
    const authService = createProviderAuthService({ dataDir: directory });
    const accessToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.redirect).toBe("error");
      if (String(url).endsWith("/deviceauth/usercode")) {
        expect(JSON.parse(String(init?.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
        return Response.json({ device_auth_id: "device-secret", user_code: "ABCD-1234", interval: "0.01" });
      }
      if (String(url).endsWith("/deviceauth/token")) {
        expect(JSON.parse(String(init?.body))).toEqual({ device_auth_id: "device-secret", user_code: "ABCD-1234" });
        return Response.json({ authorization_code: "code-secret", code_verifier: "verifier-secret" });
      }
      expect(String(url)).toBe("https://auth.openai.com/oauth/token");
      const form = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(form)).toEqual({
        grant_type: "authorization_code", client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        code: "code-secret", code_verifier: "verifier-secret", redirect_uri: "https://auth.openai.com/deviceauth/callback",
      });
      return Response.json({ access_token: accessToken, refresh_token: "refresh-secret", expires_in: 864_000 });
    });
    const oauth = createCodexOAuth({ authService, fetch: fetchImpl });
    try {
      const started = await oauth.start();
      expect(started).toMatchObject({ userCode: "ABCD-1234", verificationUri: "https://auth.openai.com/codex/device" });
      expect(JSON.stringify(started)).not.toContain("device-secret");
      await vi.waitFor(() => expect(oauth.status(started.loginId)?.state).toBe("signed_in"), { timeout: 6000 });
      expect(JSON.stringify(oauth.status(started.loginId))).not.toMatch(/secret|acct-1/);
      expect(await authService.getEntry(CODEX_AUTH_PROVIDER_ID)).toEqual({
        key: accessToken, type: "oauth", refreshToken: "refresh-secret",
        accessExpiresAt: expect.any(Number), accountId: "acct-1", version: 1,
      });
      await expect(oauth.readSubscription()).resolves.toEqual({ accessToken, accountId: "acct-1" });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      await oauth.logout();
      await expect(oauth.readSubscription()).resolves.toBeNull();
    } finally {
      oauth.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  // xAI는 RFC 8628에 scope를 더하고, 갱신이 토큰을 회전한다. quota가 401을 받으면 한 번 강제 갱신하고
  // 회전된 쌍을 저장한 뒤 다시 조회한다.
  it("signs in to xAI with its scope and keeps a rotated refresh after a refused quota read", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xai-oauth-"));
    const authService = createProviderAuthService({ dataDir: directory });
    let billingCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target === "https://auth.x.ai/oauth2/device/code") {
        expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
          client_id: "b1a00492-073a-47ea-816f-4c329264a828",
          scope: "openid profile email offline_access grok-cli:access api:access",
        });
        return Response.json({
          device_code: "device-secret", user_code: "GROK-CODE", verification_uri: "https://accounts.x.ai/device",
          verification_uri_complete: "https://accounts.x.ai/device?user_code=GROK-CODE", expires_in: 600, interval: 1,
        });
      }
      if (target === "https://auth.x.ai/oauth2/token") {
        const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
        if (form.grant_type === "refresh_token") {
          expect(form).toEqual({ grant_type: "refresh_token", client_id: "b1a00492-073a-47ea-816f-4c329264a828", refresh_token: "refresh-1" });
          return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
        }
        expect(form).toMatchObject({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "device-secret" });
        return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
      }
      expect(target).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
      billingCalls += 1;
      if (new Headers(init?.headers).get("Authorization") === "Bearer access-1") return new Response("{}", { status: 401 });
      return Response.json({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" } } });
    });
    const oauth = createXaiOAuth({ authService, fetch: fetchImpl });
    try {
      const started = await oauth.start();
      expect(started.verificationUriComplete).toBe("https://accounts.x.ai/device?user_code=GROK-CODE");
      await vi.waitFor(() => expect(oauth.status(started.loginId)?.state).toBe("signed_in"), { timeout: 4000 });
      expect(await authService.getEntry(XAI_AUTH_PROVIDER_ID)).toMatchObject({ key: "access-1", type: "oauth", refreshToken: "refresh-1", version: 1 });
      await expect(oauth.fetchUsage()).resolves.toMatchObject({ status: "ok", windows: [] });
      expect(billingCalls).toBe(2);
      expect(await authService.getEntry(XAI_AUTH_PROVIDER_ID)).toMatchObject({ key: "access-2", refreshToken: "refresh-2" });
      await expect(oauth.readSubscriptionToken()).resolves.toBe("access-2");
    } finally {
      oauth.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  // Cursor에는 device code가 없다. 사용자가 여는 URL에는 challenge만 있고, verifier는 서버의 폴링에만 실린다.
  // 갱신은 거절되므로(실측) 하지 않는다: 만료 직전에도 공급자를 부르지 않고 토큰을 쓰며, 만료 뒤에는 expired다.
  it("signs in to Cursor with a server-held PKCE verifier and uses the token until it expires without refreshing", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-oauth-"));
    const authService = createProviderAuthService({ dataDir: directory });
    const expiresAt = 2_000_000_000_000;
    const accessToken = jwt({ sub: "auth0|user-1", exp: expiresAt / 1000 });
    let now = Date.now();
    let polls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const target = new URL(String(url));
      expect(`${target.origin}${target.pathname}`).toBe("https://api2.cursor.sh/auth/poll");
      expect(init?.method).toBe("GET");
      polls += 1;
      return polls === 1 ? new Response(null, { status: 404 }) : Response.json({ accessToken, refreshToken: accessToken });
    });
    const oauth = createCursorOAuth({ authService, fetch: fetchImpl, now: () => now });
    try {
      const started = await oauth.start();
      const login = new URL(started.verificationUri);
      expect(`${login.origin}${login.pathname}`).toBe("https://cursor.com/loginDeepControl");
      expect(login.searchParams.get("redirectTarget")).toBe("cli");
      await vi.waitFor(() => expect(oauth.status(started.loginId)?.state).toBe("signed_in"), { timeout: 8000 });
      const poll = new URL(String(fetchImpl.mock.calls[0]?.[0]));
      const verifier = poll.searchParams.get("verifier") ?? "";
      expect(poll.searchParams.get("uuid")).toBe(login.searchParams.get("uuid"));
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(login.searchParams.get("challenge"));
      expect(JSON.stringify(started)).not.toContain(verifier);
      expect(await authService.getEntry(CURSOR_AUTH_PROVIDER_ID)).toEqual({ key: accessToken, type: "oauth", accessExpiresAt: expiresAt, version: 1 });
      const calls = fetchImpl.mock.calls.length;
      now = expiresAt - 60_000;
      await expect(oauth.readSubscriptionToken()).resolves.toBe(accessToken);
      now = expiresAt + 1;
      await expect(oauth.readSubscriptionToken()).resolves.toBeNull();
      await expect(oauth.fetchUsage()).resolves.toEqual({ status: "expired" });
      expect(fetchImpl).toHaveBeenCalledTimes(calls);
    } finally {
      oauth.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);

  // quota와 추론(또는 Console과 `fleet gateway serve`)이 같은 갱신 토큰으로 동시에 갱신해도
  // 먼저 저장된 회전 쌍을 늦게 온 옛 응답이 덮으면 안 된다.
  it("refreshes once per instance and never overwrites a refresh another writer already rotated", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-refresh-"));
    const authService = createProviderAuthService({ dataDir: directory });
    const now = Date.parse("2026-10-16T00:00:00Z");
    await authService.setEntry(CODEX_AUTH_PROVIDER_ID, {
      key: "access-old", type: "oauth", refreshToken: "refresh-old", accessExpiresAt: now + 60_000, accountId: "acct-1", version: 1,
    });
    const slow = deferred<Response>();
    const fast = deferred<Response>();
    const responses = [slow, fast];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-old" });
      return responses.shift()!.promise;
    });
    const quotaSide = createCodexOAuth({ authService, fetch: fetchImpl, now: () => now });
    const inferenceSide = createCodexOAuth({ authService, fetch: fetchImpl, now: () => now });
    try {
      const first = quotaSide.readSubscription();
      const joined = quotaSide.readSubscription();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      const other = inferenceSide.readSubscription();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      fast.resolve(Response.json({ access_token: "access-fast", refresh_token: "refresh-fast", expires_in: 3600 }));
      await expect(other).resolves.toEqual({ accessToken: "access-fast", accountId: "acct-1" });
      slow.resolve(Response.json({ access_token: "access-slow", refresh_token: "refresh-slow", expires_in: 3600 }));
      await expect(first).resolves.toEqual({ accessToken: "access-fast", accountId: "acct-1" });
      await expect(joined).resolves.toEqual({ accessToken: "access-fast", accountId: "acct-1" });
      expect(await authService.getEntry(CODEX_AUTH_PROVIDER_ID)).toMatchObject({ key: "access-fast", refreshToken: "refresh-fast", accountId: "acct-1" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      quotaSide.dispose();
      inferenceSide.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  // Fleet 항목이 있으면 CLI를 열지 않고, 없을 때만 읽는다. 로그아웃 표식과 만료·손상은 CLI로 계정을 바꾸지 않는다.
  it("uses a Codex CLI token only when the Console entry is absent, and leaves that file unchanged", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-fallback-"));
    const authService = createProviderAuthService({ dataDir: directory });
    const codexHome = path.join(directory, "codex-cli");
    fs.mkdirSync(codexHome);
    const vendorPath = path.join(codexHome, "auth.json");
    const vendorBody = `${JSON.stringify({ tokens: { access_token: "cli-access", account_id: "cli-acct" } })}\n`;
    fs.writeFileSync(vendorPath, vendorBody);
    let hold: Promise<void> | undefined;
    let reads = 0;
    const cliCredentials: CredentialResolverDeps = {
      platform: "darwin",
      homedir: () => path.join(directory, "no-home"),
      env: { CODEX_HOME: codexHome },
      readBounded: async (filePath, maxBytes) => {
        reads += 1;
        if (hold) await hold;
        return readBoundedFile(filePath, maxBytes);
      },
      execFile: async () => { throw new Error("vendor lookup must not spawn"); },
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    const oauth = createCodexOAuth({ authService, fetch: fetchImpl, cliCredentials, now: () => Date.parse("2026-10-17T00:00:00Z") });
    try {
      fs.writeFileSync(vendorPath, `${JSON.stringify({ tokens: { access_token: "cli-access" } })}\n`);
      await expect(oauth.readSubscription()).resolves.toBeNull();
      fs.writeFileSync(vendorPath, vendorBody);
      await expect(oauth.readSubscription()).resolves.toEqual({ accessToken: "cli-access", accountId: "cli-acct" });
      expect(fs.readFileSync(vendorPath, "utf8")).toBe(vendorBody);
      expect(fs.existsSync(path.join(directory, "auth.json"))).toBe(false);
      const readsAfterCli = reads;
      await authService.setEntry(CODEX_AUTH_PROVIDER_ID, {
        key: "fleet-access", type: "oauth", refreshToken: "fleet-refresh",
        accessExpiresAt: Date.parse("2026-10-18T00:00:00Z"), accountId: "fleet-acct", version: 1,
      });
      await expect(oauth.readSubscription()).resolves.toEqual({ accessToken: "fleet-access", accountId: "fleet-acct" });
      expect(reads).toBe(readsAfterCli);
      await authService.setEntry(CODEX_AUTH_PROVIDER_ID, {
        key: "fleet-access", type: "oauth", refreshToken: "fleet-refresh",
        accessExpiresAt: Date.parse("2026-10-16T00:00:00Z"), accountId: "fleet-acct", version: 1,
      });
      await expect(oauth.readSubscription()).resolves.toBeNull();
      expect(reads).toBe(readsAfterCli);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await authService.setEntry(CODEX_AUTH_PROVIDER_ID, { key: "broken", type: "not-oauth", version: 1 });
      await expect(oauth.fetchUsage()).rejects.toThrow(/could not be used/);
      expect(reads).toBe(readsAfterCli);
      await authService.deleteApiKey(CODEX_AUTH_PROVIDER_ID);
      let releaseLogin!: () => void;
      hold = new Promise<void>((resolve) => { releaseLogin = resolve; });
      const duringLogin = oauth.readSubscription();
      await authService.setEntry(CODEX_AUTH_PROVIDER_ID, {
        key: "fleet-new", type: "oauth", refreshToken: "fleet-new-refresh",
        accessExpiresAt: Date.parse("2026-10-18T00:00:00Z"), accountId: "fleet-new", version: 1,
      });
      releaseLogin();
      hold = undefined;
      await expect(duringLogin).resolves.toEqual({ accessToken: "fleet-new", accountId: "fleet-new" });
      expect(await authService.getEntry(CODEX_AUTH_PROVIDER_ID)).toMatchObject({ key: "fleet-new" });
      await authService.deleteApiKey(CODEX_AUTH_PROVIDER_ID);
      let release!: () => void;
      hold = new Promise<void>((resolve) => { release = resolve; });
      const pending = oauth.readSubscription();
      await oauth.logout();
      release();
      hold = undefined;
      await expect(pending).resolves.toBeNull();
      expect(await authService.getEntry(CODEX_AUTH_PROVIDER_ID)).toEqual(SUBSCRIPTION_SIGNED_OUT_ENTRY);
      expect(await authService.getApiKey(CODEX_AUTH_PROVIDER_ID)).toBe("");
      await expect(oauth.readSubscription()).resolves.toBeNull();
      expect(fs.readFileSync(vendorPath, "utf8")).toBe(vendorBody);
    } finally {
      oauth.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  // 첫 xAI 프로필이 만료면 다음 프로필로 바꾸지 않고, 401이어도 벤더 refresh를 부르지 않는다.
  it("does not refresh or rewrite a Grok CLI file, or switch to a later profile", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xai-cli-fallback-"));
    const authService = createProviderAuthService({ dataDir: directory });
    const grokHome = path.join(directory, "grok-cli");
    fs.mkdirSync(grokHome);
    const vendorPath = path.join(grokHome, "auth.json");
    const expiredFirst = {
      "https://auth.x.ai::first": {
        oidc_issuer: "https://auth.x.ai", key: "expired-access", expires_at: "2020-01-01T00:00:00.000Z",
      },
      "https://auth.x.ai::second": {
        oidc_issuer: "https://auth.x.ai", key: "other-access", expires_at: "2099-01-01T00:00:00.000Z", user_id: "user-2",
      },
    };
    const vendorBody = `${JSON.stringify(expiredFirst, null, 2)}\n`;
    fs.writeFileSync(vendorPath, vendorBody);
    const cliCredentials: CredentialResolverDeps = {
      platform: "darwin",
      homedir: () => path.join(directory, "no-home"),
      env: { GROK_HOME: grokHome },
      readBounded: readBoundedFile,
      execFile: async () => { throw new Error("vendor lookup must not spawn"); },
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 401 }));
    const oauth = createXaiOAuth({ authService, fetch: fetchImpl, cliCredentials, now: () => Date.parse("2026-10-17T00:00:00Z") });
    try {
      await expect(oauth.readSubscriptionToken()).resolves.toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
      const usable = {
        "https://auth.x.ai::only": {
          oidc_issuer: "https://auth.x.ai", key: "cli-access", expires_at: "2099-01-01T00:00:00.000Z", user_id: "user-1",
        },
      };
      const usableBody = `${JSON.stringify(usable, null, 2)}\n`;
      fs.writeFileSync(vendorPath, usableBody);
      await expect(oauth.readSubscriptionToken()).resolves.toBe("cli-access");
      await expect(oauth.fetchUsage()).resolves.toEqual({ status: "not_connected" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/v1/billing");
      await expect(oauth.readSubscriptionToken()).resolves.toBeNull();
      expect(fs.readFileSync(vendorPath, "utf8")).toBe(usableBody);
      expect(fs.existsSync(path.join(directory, "auth.json"))).toBe(false);
    } finally {
      oauth.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
