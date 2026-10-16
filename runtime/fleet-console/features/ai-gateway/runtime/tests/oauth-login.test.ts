import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProviderAuthService } from "../src/auth/index.js";
import { createMuseCodeOAuth, MUSE_CODE_AUTH_PROVIDER_ID } from "../src/oauth/index.js";

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
