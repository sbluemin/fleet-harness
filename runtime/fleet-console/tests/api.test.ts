import { afterEach, describe, expect, it, vi } from "vitest";

import { applyConsoleUpdate, fetchReleaseNotes, fetchTenants } from "../client/src/api.js";

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

  it("fetches release notes through the observer proxy and validates the payload", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      notes: [{ version: "1.0.0", date: "2026-06-20", sections: [{ heading: "Changed", items: [{ packageTags: ["fleet-console"], text: "Runtime notes." }] }] }],
      sourceRef: "main",
      fetchedAt: 10,
      stale: false,
    }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(fetchReleaseNotes({ force: true })).resolves.toMatchObject({ sourceRef: "main", notes: [{ version: "1.0.0" }] });

    expect(fetchMock).toHaveBeenCalledWith("/observer/release-notes?force=true", { signal: undefined });
  });

  it("rejects malformed release note payloads", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      notes: [{ version: "1.0.0", date: "2026-06-20", sections: [{ heading: "Changed", items: ["raw markdown"] }] }],
      sourceRef: "main",
      fetchedAt: 10,
      stale: false,
    }), { status: 200 })) as typeof fetch;

    await expect(fetchReleaseNotes()).rejects.toMatchObject({
      name: "ApiError",
      message: "Invalid release notes response",
    });
  });
});
