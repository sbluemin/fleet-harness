import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { codexAuthFilePath, resolveCodexCredentials } from "../src/upstream/codex/credentials.js";
import { museInferenceKey, resolveMuseAuth } from "../src/upstream/muse-code/credentials.js";
import type { CredentialResolverDeps } from "../src/transport/credentials.js";

function deps(overrides: Partial<CredentialResolverDeps> = {}): CredentialResolverDeps {
  return {
    platform: "linux",
    homedir: () => "/users/operator",
    env: {},
    readBounded: vi.fn(async () => null),
    execFile: vi.fn(async () => ""),
    ...overrides,
  };
}

describe("codex credential procurement", () => {
  const codexAuth = (tokens: Record<string, unknown>): string => JSON.stringify({ tokens });

  it("reads the default codex home and never shells out on any platform", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const execFile = vi.fn(async () => "");
      const readBounded = vi.fn(async () => codexAuth({ access_token: "codex-token", account_id: "acct-1" }));
      const result = await resolveCodexCredentials(deps({ platform, execFile, readBounded }));
      expect(execFile).not.toHaveBeenCalled();
      expect(readBounded).toHaveBeenCalledWith(path.join("/users/operator", ".codex", "auth.json"), 65_536);
      expect(result).toEqual({ accessToken: "codex-token", accountId: "acct-1" });
    }
  });

  // The gateway used to read ~/.codex/auth.json directly, so a relocated Codex
  // home resolved no token there while the quota reader found it.
  it("honors CODEX_HOME when the Codex home is relocated", async () => {
    const readBounded = vi.fn(async () => codexAuth({ access_token: "codex-token", account_id: "acct-1" }));
    await resolveCodexCredentials(deps({ env: { CODEX_HOME: "/custom/codex" }, readBounded }));
    expect(readBounded).toHaveBeenCalledWith(path.join("/custom/codex", "auth.json"), 65_536);
    expect(codexAuthFilePath(deps({ env: { CODEX_HOME: "/custom/codex" } })))
      .toBe(path.join("/custom/codex", "auth.json"));
  });

  it("keeps the account id optional so a quota reader can use a token without one", async () => {
    const result = await resolveCodexCredentials(deps({
      readBounded: async () => codexAuth({ access_token: "codex-token" }),
    }));
    expect(result).toEqual({ accessToken: "codex-token" });
  });

  it("stores the token verbatim rather than trimming it", async () => {
    const result = await resolveCodexCredentials(deps({
      readBounded: async () => codexAuth({ access_token: " codex-token ", account_id: "acct-1" }),
    }));
    expect(result).toEqual({ accessToken: " codex-token ", accountId: "acct-1" });
  });

  it("returns null when the token is absent, empty, or the file is unreadable", async () => {
    await expect(resolveCodexCredentials(deps({ readBounded: async () => codexAuth({ account_id: "acct-1" }) })))
      .resolves.toBeNull();
    await expect(resolveCodexCredentials(deps({ readBounded: async () => codexAuth({ access_token: "" }) })))
      .resolves.toBeNull();
    await expect(resolveCodexCredentials(deps({ readBounded: async () => "{" })))
      .resolves.toBeNull();
    await expect(resolveCodexCredentials(deps({ readBounded: async () => null })))
      .resolves.toBeNull();
    await expect(resolveCodexCredentials(deps({
      readBounded: async () => {
        throw new Error("EACCES");
      },
    }))).resolves.toBeNull();
  });
});

describe("Muse Code credential procurement", () => {
  const metadata = (meta: Record<string, unknown> | undefined, schemaVersion = 2): string =>
    JSON.stringify({ schema_version: schemaVersion, providers: meta === undefined ? {} : { meta } });
  const signedIn = metadata({ mechanism: "oauth", storage: "keychain", user_email: "person@example.com" });
  const secret = (fields: Record<string, unknown> = {}): string => `${JSON.stringify({
    secret_schema_version: 1,
    api_key: " LLM|model-key ",
    access_token: "account-token",
    ...fields,
  })}\n`;
  const exitWith = (fields: Record<string, unknown>) => async () => {
    throw Object.assign(new Error("security failed: secret-looking stderr"), fields);
  };

  it("reads only the vendor login, via the keychain item it names, and keeps the secrets verbatim", async () => {
    const readBounded = vi.fn(async () => signedIn);
    const execFile = vi.fn(async () => secret());
    const result = await resolveMuseAuth(deps({
      platform: "darwin",
      // 둘 다 Fleet을 다른 파일이나 Meta 종량제 키로 돌려서는 안 된다.
      env: { XDG_CONFIG_HOME: "/xdg", MUSE_AUTH_PATH: "/elsewhere/auth.json", META_API_KEY: "payg-key" },
      readBounded,
      execFile,
    }));

    expect(result).toEqual({
      status: "ok",
      credentials: { apiKey: " LLM|model-key ", accountToken: "account-token", method: "keychain" },
    });
    expect(readBounded).toHaveBeenCalledTimes(1);
    expect(readBounded).toHaveBeenCalledWith(path.join("/xdg", "muse", "auth.json"), expect.any(Number));
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/security",
      ["find-generic-password", "-s", "ai.meta.dev.credentials", "-a", "meta", "-w"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(museInferenceKey(result)).toEqual({ apiKey: " LLM|model-key " });
  });

  it("tells signed out, keychain refusal, and unreadable layouts apart without leaking their text", async () => {
    const resolve = (readBounded: CredentialResolverDeps["readBounded"], execFile = vi.fn(async () => secret())) =>
      resolveMuseAuth(deps({ platform: "darwin", readBounded, execFile }));
    const missing = async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };

    await expect(resolve(missing)).resolves.toEqual({ status: "signed_out" });
    await expect(resolve(async () => metadata({ mechanism: "api_key", storage: "keychain" })))
      .resolves.toEqual({ status: "signed_out" });
    await expect(resolve(async () => signedIn, vi.fn(exitWith({ code: 44 }))))
      .resolves.toEqual({ status: "signed_out" });
    await expect(resolve(async () => signedIn, vi.fn(exitWith({ code: null, killed: true, signal: "SIGTERM" }))))
      .resolves.toEqual({ status: "unavailable", reason: "keychain_timeout" });
    await expect(resolve(async () => signedIn, vi.fn(exitWith({ code: 51 }))))
      .resolves.toEqual({ status: "unavailable", reason: "keychain_denied" });
    // 모르는 레이아웃은 추측하지 않고 거부한다.
    await expect(resolve(async () => metadata({ mechanism: "oauth", storage: "keychain" }, 3)))
      .resolves.toEqual({ status: "unavailable", reason: "malformed" });
    await expect(resolve(async () => signedIn, vi.fn(async () => secret({ secret_schema_version: 2 }))))
      .resolves.toEqual({ status: "unavailable", reason: "malformed" });

    const denied = await resolve(async () => signedIn, vi.fn(exitWith({ code: 51 })));
    const guidance = museInferenceKey(denied);
    expect(guidance.apiKey).toBeUndefined();
    expect(JSON.stringify(guidance)).not.toMatch(/stderr|example\.com/);
    // 계정 토큰만으로는 추론 자격 증명이 아니다.
    expect(museInferenceKey({ status: "ok", credentials: { accountToken: "t", method: "keychain" } }).apiKey)
      .toBeUndefined();
  });
});
