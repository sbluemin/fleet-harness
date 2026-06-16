import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTenants } from "../client/src/api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("client api parsing", () => {
  it("rejects tenant payloads that include browser-forbidden fields", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      tenants: [{
        tenantId: "tenant-a",
        tenantLabel: "Alpha",
        createdAt: 1,
        sessions: 1,
        providerSession: { sessionId: "provider-session-secret" },
      }],
    }), { status: 200 })) as typeof fetch;

    await expect(fetchTenants()).rejects.toMatchObject({
      name: "ApiError",
      message: "Invalid tenants response",
    });
  });
});
