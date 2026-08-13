import { describe, expect, it, vi } from "vitest";

import {
  XAI_CLI_CLIENT_VERSION,
  XAI_CLI_CREDITS_URL,
  XAI_CLI_RESPONSES_URL,
  XaiResponsesAdapter,
  fetchXaiUsage,
  parseXaiCredits,
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
});

describe("Grok quota", () => {
  it("parses the weekly credits window", () => {
    expect(parseXaiCredits({ config: {
      creditUsagePercent: 42.4,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-10T00:00:00Z",
        end: "2026-08-17T00:00:00Z",
      },
    } })).toMatchObject({
      id: "weekly",
      usedPercent: 42,
      resetsAt: Date.parse("2026-08-17T00:00:00Z"),
      period: { durationBasis: "upstream", startsAtBasis: "upstream" },
    });
    expect(XAI_CLI_CREDITS_URL).toContain("billing?format=credits");
  });

  it("rejects a credits response without a finite usage percentage", () => {
    const period = {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-08-10T00:00:00Z",
      end: "2026-08-17T00:00:00Z",
    };
    expect(parseXaiCredits({ config: { currentPeriod: period } })).toBeNull();
    expect(parseXaiCredits({ config: { creditUsagePercent: Number.NaN, currentPeriod: period } })).toBeNull();
  });

  it("reads weekly credits with Grok CLI subscription headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ config: {
      creditUsagePercent: 42.4,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-10T00:00:00Z",
        end: "2026-08-17T00:00:00Z",
      },
    } }), { status: 200, headers: { "content-type": "application/json" } }));
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
