import { describe, expect, it, vi } from "vitest";

import {
  XAI_CLI_CLIENT_VERSION,
  XAI_CLI_CREDITS_URL,
  XAI_CLI_REFRESH_URL,
  XAI_CLI_RESPONSES_URL,
  XaiResponsesAdapter,
  fetchXaiUsage,
  parseXaiCredits,
  resolveXaiCliAuth,
  resolveXaiCliCredentials,
  xaiCliAuthFilePath,
} from "../src/index.js";
import type { CanonicalResponseRequest, CredentialResolverDeps } from "../src/index.js";

function deps(raw: string | null, env: NodeJS.ProcessEnv = {}): CredentialResolverDeps {
  return {
    platform: "linux",
    homedir: () => "/home/test",
    env,
    readBounded: vi.fn(async () => raw),
    execFile: vi.fn(async () => ""),
  };
}

function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

const WEEKLY_PERIOD = {
  type: "USAGE_PERIOD_TYPE_WEEKLY",
  start: "2026-08-10T00:00:00Z",
  end: "2026-08-17T00:00:00Z",
};

function creditsResponse(config: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ config }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refreshResponse(accessToken: string, expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Grok CLI credentials", () => {
  it("honors GROK_HOME and reads a fresh auth.x.ai entry", async () => {
    const credentialDeps = deps(JSON.stringify({
      "https://auth.x.ai::profile": {
        key: "access-token",
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-14T01:00:00Z",
        user_id: "user-1",
      },
    }), { GROK_HOME: "/custom/grok" });
    expect(xaiCliAuthFilePath(credentialDeps)).toBe("/custom/grok/auth.json");
    await expect(resolveXaiCliCredentials(credentialDeps, () => Date.parse("2026-08-14T00:00:00Z")))
      .resolves.toEqual({ accessToken: "access-token", expiresAt: Date.parse("2026-08-14T01:00:00Z"), userId: "user-1" });
  });

  it("rejects expired, wrong-issuer, and malformed entries", async () => {
    await expect(resolveXaiCliCredentials(deps(JSON.stringify({
      "https://auth.x.ai::profile": { key: "token", oidc_issuer: "https://auth.x.ai", expires_at: "2026-08-13T00:00:00Z" },
    })), () => Date.parse("2026-08-14T00:00:00Z"))).resolves.toBeNull();
    await expect(resolveXaiCliCredentials(deps(JSON.stringify({
      "https://auth.x.ai::profile": { key: "token", oidc_issuer: "https://evil.example" },
    })))).resolves.toBeNull();
  });

  it("skips an expired profile when another active Grok CLI profile exists", async () => {
    await expect(resolveXaiCliCredentials(deps(JSON.stringify({
      "https://auth.x.ai::expired": {
        key: "expired-token",
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-13T00:00:00Z",
      },
      "https://auth.x.ai::active": {
        key: "active-token",
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-15T00:00:00Z",
      },
    })), () => Date.parse("2026-08-14T00:00:00Z"))).resolves.toMatchObject({
      accessToken: "active-token",
    });
  });

  it("silently refreshes a still-renewable token and persists the replacement", async () => {
    const auth = {
      "https://auth.x.ai::profile": {
        key: jwtWithExp(Math.floor(Date.parse("2026-08-14T00:04:00Z") / 1_000)),
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-14T00:04:00Z",
        refresh_token: "refresh-1",
        oidc_client_id: "client-1",
        user_id: "user-1",
      },
    };
    const credentialDeps = deps(JSON.stringify(auth));
    const writeAuthFile = vi.fn(async () => {});
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toBe(XAI_CLI_REFRESH_URL);
      return refreshResponse("fresh-token", 7_200);
    });
    const result = await resolveXaiCliAuth(credentialDeps, {
      now: () => Date.parse("2026-08-14T00:00:00Z"),
      fetch: fetchMock,
      writeAuthFile,
    });
    expect(result).toEqual({
      status: "ok",
      credentials: {
        accessToken: "fresh-token",
        expiresAt: Date.parse("2026-08-14T02:00:00Z"),
        userId: "user-1",
      },
    });
    expect(writeAuthFile).toHaveBeenCalledTimes(1);
    const written = writeAuthFile.mock.calls.at(0)?.at(1);
    expect(JSON.parse(String(written))["https://auth.x.ai::profile"]).toMatchObject({
      key: "fresh-token",
      refresh_token: "refresh-1",
      user_id: "user-1",
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(String(init?.body)).toContain("grant_type=refresh_token");
    expect(String(init?.body)).toContain("client_id=client-1");
    expect(String(init?.body)).toContain("refresh_token=refresh-1");
  });

  it("reports expired when every renewable profile fails to refresh", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("invalid_grant", { status: 400 }));
    await expect(resolveXaiCliAuth(deps(JSON.stringify({
      "https://auth.x.ai::profile": {
        key: "stale",
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-13T00:00:00Z",
        refresh_token: "refresh-1",
      },
    })), {
      now: () => Date.parse("2026-08-14T00:00:00Z"),
      fetch: fetchMock,
    })).resolves.toEqual({ status: "expired" });
  });
});

describe("Grok quota", () => {
  it("parses the weekly credits window", () => {
    expect(parseXaiCredits({ config: {
      creditUsagePercent: 42.4,
      currentPeriod: WEEKLY_PERIOD,
    } })).toMatchObject({
      status: "weekly",
      window: {
        id: "weekly",
        usedPercent: 42,
        resetsAt: Date.parse("2026-08-17T00:00:00Z"),
        period: { durationBasis: "upstream", startsAtBasis: "upstream" },
      },
    });
    expect(XAI_CLI_CREDITS_URL).toContain("billing?format=credits");
  });

  it("treats an omitted creditUsagePercent as a genuine 0%", () => {
    // proto3 JSON drops zeros. OpenUsage documents the same shape: absent means 0, not drift.
    expect(parseXaiCredits({ config: { currentPeriod: WEEKLY_PERIOD } })).toMatchObject({
      status: "weekly",
      window: { id: "weekly", usedPercent: 0 },
    });
  });

  it("rejects a present non-finite usage percentage and accepts a non-weekly period as empty", () => {
    expect(parseXaiCredits({ config: { creditUsagePercent: Number.NaN, currentPeriod: WEEKLY_PERIOD } })).toBeNull();
    expect(parseXaiCredits({ config: {
      currentPeriod: { ...WEEKLY_PERIOD, type: "USAGE_PERIOD_TYPE_MONTHLY" },
    } })).toEqual({ status: "other" });
  });

  it("reads weekly credits with Grok CLI subscription headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => creditsResponse({
      creditUsagePercent: 42.4,
      currentPeriod: WEEKLY_PERIOD,
    }));
    const result = await fetchXaiUsage({
      credentials: deps(JSON.stringify({
        "https://auth.x.ai::profile": {
          key: "access-token",
          oidc_issuer: "https://auth.x.ai",
          expires_at: "2026-08-15T00:00:00Z",
          user_id: "user-1",
        },
      })),
      fetch: fetchMock,
      now: () => Date.parse("2026-08-14T00:00:00Z"),
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(String(url)).toBe(XAI_CLI_CREDITS_URL);
    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(headers.get("x-userid")).toBe("user-1");
    expect(result).toMatchObject({ status: "ok", windows: [{ id: "weekly", usedPercent: 42 }] });
  });

  it("returns an empty weekly window when proto-JSON omitted the 0% field", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => creditsResponse({ currentPeriod: WEEKLY_PERIOD }));
    await expect(fetchXaiUsage({
      credentials: deps(JSON.stringify({
        "https://auth.x.ai::profile": {
          key: "access-token",
          oidc_issuer: "https://auth.x.ai",
          expires_at: "2026-08-15T00:00:00Z",
        },
      })),
      fetch: fetchMock,
      now: () => Date.parse("2026-08-14T00:00:00Z"),
    })).resolves.toMatchObject({ status: "ok", windows: [{ id: "weekly", usedPercent: 0 }] });
  });

  it("refreshes once after a 401 and retries the credits request", async () => {
    const auth = {
      "https://auth.x.ai::profile": {
        key: "stale-token",
        oidc_issuer: "https://auth.x.ai",
        expires_at: "2026-08-15T00:00:00Z",
        refresh_token: "refresh-1",
        user_id: "user-1",
      },
    };
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("unexpected fetch");
    });
    fetchMock
      .mockImplementationOnce(async () => new Response("unauthorized", { status: 401 }))
      .mockImplementationOnce(async (url) => {
        expect(String(url)).toBe(XAI_CLI_REFRESH_URL);
        return refreshResponse("fresh-token");
      })
      .mockImplementationOnce(async (url, init) => {
        expect(String(url)).toBe(XAI_CLI_CREDITS_URL);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-token");
        return creditsResponse({ creditUsagePercent: 7, currentPeriod: WEEKLY_PERIOD });
      });
    const result = await fetchXaiUsage({
      credentials: deps(JSON.stringify(auth)),
      fetch: fetchMock,
      now: () => Date.parse("2026-08-14T00:00:00Z"),
    });
    expect(result).toMatchObject({ status: "ok", windows: [{ usedPercent: 7 }] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("Grok Responses adapter", () => {
  it("uses the CLI proxy with subscription and model headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("data: [DONE]\n\n", { status: 200 }));
    const request: CanonicalResponseRequest = {
      model: "grok-4.6",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
      metadata: { user_id: "caller-metadata" },
    };
    await new XaiResponsesAdapter({ fetch: fetchMock }).stream(request, { apiKey: "session-token" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(String(url)).toBe(XAI_CLI_RESPONSES_URL);
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(headers.get("x-grok-client-version")).toBe(XAI_CLI_CLIENT_VERSION);
    expect(headers.get("x-grok-model-override")).toBe("grok-4.6");
    expect(body).toMatchObject({
      model: "grok-4.6",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
    });
    expect(body).not.toHaveProperty("metadata");
  });
});
