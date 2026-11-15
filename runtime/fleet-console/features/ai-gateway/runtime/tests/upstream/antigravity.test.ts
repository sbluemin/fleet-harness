import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ANTIGRAVITY_LOAD_CODE_ASSIST_URL,
  ANTIGRAVITY_QUOTA_SUMMARY_URLS,
  antigravityPlanLabel,
  antigravityUserAgent,
  fetchAntigravityUsage,
  loadAntigravityCodeAssist,
  parseAntigravityQuotaSummary,
  resolveAntigravityAuth,
} from "../../src/index.js";
import type { CredentialResolverDeps } from "../../src/index.js";

const ACCESS = "ya29.a0-access-token";
const REFRESH = "1//0-refresh-token";

function keychainValue(token: Record<string, unknown>): string {
  const payload = JSON.stringify({ token, auth_method: "consumer" });
  return `go-keyring-base64:${Buffer.from(payload, "utf8").toString("base64")}`;
}

function credentialDeps(overrides: Partial<CredentialResolverDeps> = {}): CredentialResolverDeps {
  return {
    platform: "darwin",
    homedir: () => "/home/tester",
    env: {},
    readBounded: async () => null,
    execFile: async () => keychainValue({
      access_token: ACCESS,
      token_type: "Bearer",
      refresh_token: REFRESH,
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    ...overrides,
  };
}

describe("antigravity quota", () => {
  it("does not read credentials on Windows without an Antigravity footprint", async () => {
    const execFile = vi.fn<CredentialResolverDeps["execFile"]>();
    const readBounded = vi.fn<CredentialResolverDeps["readBounded"]>();
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await fetchAntigravityUsage({
      credentials: credentialDeps({ platform: "win32", execFile, readBounded }),
      stat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      fetch: fetchImpl,
    });
    expect(result).toEqual({ status: "signed_out" });
    expect(execFile).not.toHaveBeenCalled();
    expect(readBounded).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("collects separate Gemini pools when a Windows installation hint exists", async () => {
    const home = "C:\\Users\\tester";
    const cliDirectory = path.win32.join(home, ".gemini", "antigravity-cli");
    const execFile = vi.fn<CredentialResolverDeps["execFile"]>().mockResolvedValue(
      Buffer.from(keychainValue({ access_token: ACCESS }), "utf8").toString("base64"),
    );
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => new Response(JSON.stringify(
      url === ANTIGRAVITY_QUOTA_SUMMARY_URLS[0]
        ? { groups: [
          { displayName: "Gemini 4 Argon", buckets: [{
            bucketId: "gemini-argon-wtu-weekly",
            remainingFraction: 0.98970413,
            resetTime: "2026-10-24T22:20:43Z",
          }] },
          { displayName: "Claude and GPT models", buckets: [
            { bucketId: "3p-5h", remainingFraction: 0 },
            { bucketId: "3p-weekly", remainingFraction: 0 },
          ] },
          { displayName: "Gemini Models", buckets: [
            { bucketId: "gemini-weekly", remainingFraction: 0.5 },
            { bucketId: "gemini-5h", remainingFraction: 0.75 },
          ] },
        ] }
        : {},
    )));
    const deps = {
      credentials: credentialDeps({ platform: "win32", homedir: () => home, execFile }),
      stat: async (filePath: string) => {
        if (filePath === cliDirectory) return {};
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      fetch: fetchImpl,
    };
    const result = await fetchAntigravityUsage(deps);
    expect(result).toMatchObject({
      status: "ok",
      method: "keychain",
      windows: [
        { id: "session", label: "Gemini", usedPercent: 25 },
        { id: "weekly", label: "Gemini", usedPercent: 50 },
        {
          id: "weekly",
          scope: "model:gemini-4-argon",
          label: "Gemini 4 Argon",
          usedPercent: 1,
          resetsAt: Date.parse("2026-10-24T22:20:43Z"),
          period: { durationMs: 604_800_000, durationBasis: "catalog" },
        },
      ],
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(ANTIGRAVITY_QUOTA_SUMMARY_URLS[0], expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${ACCESS}` }),
    }));

    // A host without the Argon pool still reports its available Gemini window.
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({
      groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.75 }] }],
    })));
    expect(await fetchAntigravityUsage(deps)).toMatchObject({
      status: "ok",
      windows: [{ id: "session", label: "Gemini", usedPercent: 25 }],
    });
  });
});

describe("antigravity credentials", () => {
  it("reads whichever store the CLI chose and keeps the fresher token when both hold one", async () => {
    const tokenFile = path.join("/home/tester", ".gemini", "antigravity-cli", "antigravity-oauth-token");
    const fileExpiry = new Date(Date.now() + 3_600_000).toISOString();
    const keychainExpiry = new Date(Date.now() + 7_200_000).toISOString();
    const readBounded = async (filePath: string): Promise<string | null> => {
      if (filePath !== tokenFile) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return JSON.stringify({
        token: { access_token: "file-access", token_type: "Bearer", refresh_token: REFRESH, expiry: fileExpiry },
        auth_method: "consumer",
      });
    };

    // Over SSH `agy` keeps its login in the file and leaves no keychain item.
    const itemNotFound = Object.assign(new Error("item not found"), { code: 44 });
    const fileOnly = await resolveAntigravityAuth(credentialDeps({
      readBounded,
      execFile: async () => { throw itemNotFound; },
    }));
    expect(fileOnly).toEqual({
      status: "ok",
      credentials: { accessToken: "file-access", method: "file", expiresAt: Date.parse(fileExpiry) },
    });

    // A later run that chose the keychain renewed only that store.
    const both = await resolveAntigravityAuth(credentialDeps({
      readBounded,
      execFile: async () => keychainValue({ access_token: ACCESS, refresh_token: REFRESH, expiry: keychainExpiry }),
    }));
    expect(both).toEqual({
      status: "ok",
      credentials: { accessToken: ACCESS, method: "keychain", expiresAt: Date.parse(keychainExpiry) },
    });
  });

  it("runs one renewal for concurrent callers rather than racing the credential store", async () => {
    const execFile = vi.fn(async (_file: string, _args: readonly string[]) => keychainValue({
      access_token: ACCESS,
      refresh_token: REFRESH,
      expiry: new Date(Date.now() + 10_000).toISOString(),
    }));
    let running = 0;
    let overlapped = false;
    const refreshVendorCredential = vi.fn(async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });
    const deps = credentialDeps({ execFile });
    await Promise.all([
      resolveAntigravityAuth(deps, { refreshVendorCredential }),
      resolveAntigravityAuth(deps, { refreshVendorCredential }),
      resolveAntigravityAuth(deps, { refreshVendorCredential }),
    ]);
    expect(overlapped).toBe(false);
    expect(refreshVendorCredential).toHaveBeenCalledTimes(1);
  });

  it("never runs the vendor CLI on Windows, judging the stored token as-is", async () => {
    // The win32 reader emits the blob base64-encoded; the mock must too, or the
    // value decodes into a bare token with no expiry.
    const keychain = (expiry: string): CredentialResolverDeps["execFile"] =>
      (async () => Buffer.from(
        keychainValue({ access_token: ACCESS, refresh_token: REFRESH, expiry }),
        "utf8",
      ).toString("base64")) as CredentialResolverDeps["execFile"];
    const refreshVendorCredential = vi.fn(async () => {});
    const fresh = await resolveAntigravityAuth(
      credentialDeps({
        platform: "win32",
        execFile: keychain(new Date(Date.now() + 3_600_000).toISOString()),
      }),
      { forceRefresh: true, refreshVendorCredential },
    );
    expect(fresh.status).toBe("ok");
    const stale = await resolveAntigravityAuth(
      credentialDeps({
        platform: "win32",
        execFile: keychain(new Date(Date.now() - 60_000).toISOString()),
      }),
      { forceRefresh: true, refreshVendorCredential },
    );
    expect(stale).toEqual({ status: "expired" });
    expect(refreshVendorCredential).not.toHaveBeenCalled();
  });
});
