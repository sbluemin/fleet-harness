import { afterEach, describe, expect, it, vi } from "vitest";

import { applyConsoleUpdate, fetchTenants } from "../client/src/api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("client api parsing", () => {
  it("requests update apply without browser-controlled package targets", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "accepted" }), { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(applyConsoleUpdate()).resolves.toEqual({ status: "accepted" });

    expect(fetchMock).toHaveBeenCalledWith("/update/apply", { method: "POST", signal: undefined });
  });

  it("rejects update apply responses that expose package targets", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: "accepted",
      packageName: "hidden-target",
    }), { status: 202 })) as typeof fetch;

    await expect(applyConsoleUpdate()).rejects.toMatchObject({
      name: "ApiError",
      message: "Invalid update apply response",
    });
  });

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
