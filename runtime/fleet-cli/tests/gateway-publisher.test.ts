import { describe, expect, it, vi } from "vitest";

import { createGatewayDedicatedSessionManager } from "../src/runtime/gateway.js";

describe("gateway observability publisher", () => {
  it("publishes each carrier event to the primary active gateway tenant only", async () => {
    const posts: string[] = [];
    const manager = createManager(posts);

    await manager.issueSessionToken({ label: "first", cwd: "/tmp/first" });
    await manager.issueSessionToken({ label: "second", cwd: "/tmp/second" });
    manager.publishJobEvent({ type: "job:registered", jobId: "job", kind: "single", ownerCarrierId: "carrier", label: "Job", startedAt: 1, tracks: [] });
    await waitFor(() => posts.length === 1);

    expect(posts).toEqual(["control-first"]);
  });

  it("fails over to the next active tenant when the primary is released", async () => {
    const posts: string[] = [];
    const manager = createManager(posts);

    await manager.issueSessionToken({ label: "first", cwd: "/tmp/first" });
    await manager.issueSessionToken({ label: "second", cwd: "/tmp/second" });
    manager.releaseSessionToken("first");
    manager.publishJobEvent({ type: "job:registered", jobId: "job", kind: "single", ownerCarrierId: "carrier", label: "Job", startedAt: 1, tracks: [] });
    await waitFor(() => posts.length === 1);

    expect(posts).toEqual(["control-second"]);
  });

  it("updates connection state once when primary publish fails", async () => {
    const manager = createManager([], 503);

    await manager.issueSessionToken({ label: "first", cwd: "/tmp/first" });
    await manager.issueSessionToken({ label: "second", cwd: "/tmp/second" });
    manager.publishJobEvent({ type: "job:registered", jobId: "job", kind: "single", ownerCarrierId: "carrier", label: "Job", startedAt: 1, tracks: [] });
    await waitFor(() => manager.getConnectionState().state === "retrying");

    expect(manager.getConnectionState()).toMatchObject({ state: "retrying", attempts: 1 });
  });
});

function createManager(posts: string[], publishStatus = 200) {
  return createGatewayDedicatedSessionManager({
    name: "fleet",
    lifecycle: { ensureDaemon: async () => "http://127.0.0.1:37283/mcp" } as never,
    readBootstrapToken: async () => "bootstrap",
    registry: {
      getAllAgentTools: () => [{ id: "ping", description: "Ping", parameters: {} }],
      invoke: vi.fn(),
    } as never,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/admin/register")) {
        const label = JSON.parse(String(init?.body)).tenantLabel as string;
        return jsonResponse({
          tenantId: `tenant-${label}`,
          sessionId: `session-${label}`,
          endpoint: "http://127.0.0.1:37283/mcp",
          controlToken: `control-${label}`,
          sessionToken: `session-${label}`,
          observerToken: `observer-${label}`,
        });
      }
      if (target.endsWith("/control/calls")) {
        return new Response(new ReadableStream(), { status: 200 });
      }
      if (target.endsWith("/control/events")) {
        posts.push(String(init?.headers instanceof Headers ? init.headers.get("Authorization") : (init?.headers as Record<string, string>).Authorization).replace("Bearer ", ""));
        return jsonResponse({ ok: publishStatus === 200 }, publishStatus);
      }
      if (target.endsWith("/control/release")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    }) as typeof fetch,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}
