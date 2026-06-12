import { describe, expect, it, vi } from "vitest";

import { createGatewayDedicatedSessionManager } from "../src/runtime/gateway.js";

interface CapturedInvocation {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

interface ControlledGatewayCallStream {
  readonly ready: boolean;
  emit(call: { readonly callId: string; readonly sessionId: string; readonly toolName: string; readonly args: Record<string, unknown> }): void;
  stream(): ReadableStream<Uint8Array>;
}

interface ResultPost {
  readonly callId: string;
  readonly sessionId: string;
  readonly token: string;
}

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

  it("rebinds pooled executor calls to the installed cwd and current request signal", async () => {
    const calls = createControlledGatewayCallStream();
    const resultPosts: string[] = [];
    const invocations: CapturedInvocation[] = [];
    const invoke = vi.fn(async (_toolName: string, _args: Record<string, unknown>, ctx: CapturedInvocation) => {
      invocations.push({ cwd: ctx.cwd, signal: ctx.signal });
      if (!ctx.signal?.aborted) {
        await waitForAbort(ctx.signal);
      }
      return { content: [{ type: "text", text: "aborted" }], isError: false };
    });
    const manager = createExecutorManager(calls, invoke, resultPosts);
    const firstRequest = new AbortController();
    const currentRequest = new AbortController();

    const session = await manager.createExecutorMcpSession({
      serverName: "fleet",
      specs: [{ id: "ping", description: "Ping", parameters: {} }],
      cwd: "/tmp/first",
      signal: firstRequest.signal,
    });
    await waitFor(() => calls.ready);

    session.installForReuse?.({ cwd: "/tmp/current", signal: currentRequest.signal });
    calls.emit({ callId: "call-current", sessionId: "session-current", toolName: "ping", args: {} });
    await waitFor(() => invocations.length === 1);

    expect(invocations[0]?.cwd).toBe("/tmp/current");
    firstRequest.abort();
    expect(invocations[0]?.signal?.aborted).toBe(false);

    currentRequest.abort();
    await waitFor(() => resultPosts.includes("call-current"));
    expect(invocations[0]?.signal?.aborted).toBe(true);

    session.cleanup();
  });

  it("detaches pooled executor calls from the previous request signal until reuse is installed", async () => {
    const calls = createControlledGatewayCallStream();
    const resultPosts: string[] = [];
    const invocations: CapturedInvocation[] = [];
    const invoke = vi.fn(async (_toolName: string, _args: Record<string, unknown>, ctx: CapturedInvocation) => {
      invocations.push({ cwd: ctx.cwd, signal: ctx.signal });
      if (!ctx.signal?.aborted) {
        await waitForAbort(ctx.signal);
      }
      return { content: [{ type: "text", text: "stopped" }], isError: false };
    });
    const manager = createExecutorManager(calls, invoke, resultPosts);
    const previousRequest = new AbortController();
    const nextRequest = new AbortController();

    const session = await manager.createExecutorMcpSession({
      serverName: "fleet",
      specs: [{ id: "ping", description: "Ping", parameters: {} }],
      cwd: "/tmp/previous",
      signal: previousRequest.signal,
    });
    await waitFor(() => calls.ready);

    session.detachForReuse?.();
    previousRequest.abort();
    session.installForReuse?.({ cwd: "/tmp/next", signal: nextRequest.signal });
    calls.emit({ callId: "call-next", sessionId: "session-next", toolName: "ping", args: {} });
    await waitFor(() => invocations.length === 1);

    expect(invocations[0]?.cwd).toBe("/tmp/next");
    expect(invocations[0]?.signal?.aborted).toBe(false);

    session.cleanup();
    await waitFor(() => resultPosts.includes("call-next"));
    expect(invocations[0]?.signal?.aborted).toBe(true);
  });

  it("resubscribes the control stream after a transient disconnect without re-registering", async () => {
    let registerCount = 0;
    let callStreamCount = 0;
    const releases: string[] = [];
    const manager = createGatewayDedicatedSessionManager({
      name: "fleet",
      lifecycle: { ensureDaemon: async () => "http://127.0.0.1:37283/mcp" } as never,
      readBootstrapToken: async () => "bootstrap",
      sleep: async () => undefined,
      registry: {
        getAllAgentTools: () => [{ id: "ping", description: "Ping", parameters: {} }],
        invoke: vi.fn(),
      } as never,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith("/admin/register")) {
          registerCount += 1;
          return jsonResponse({
            tenantId: `tenant-${registerCount}`,
            sessionId: `session-${registerCount}`,
            endpoint: "http://127.0.0.1:37283/mcp",
            controlToken: `control-${registerCount}`,
            sessionToken: `session-token-${registerCount}`,
            observerToken: `observer-${registerCount}`,
          });
        }
        if (target.endsWith("/control/calls")) {
          callStreamCount += 1;
          return callStreamCount === 1
            ? new Response(closedStream(), { status: 200 })
            : new Response(new ReadableStream(), { status: 200 });
        }
        if (target.endsWith("/control/release")) {
          releases.push(authorizationToken(init));
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      }) as typeof fetch,
    });

    const tokens = await manager.issueSessionToken({ label: "agent:transient", cwd: "/tmp/first" });
    await waitFor(() => callStreamCount >= 2);
    manager.releaseSessionToken("agent:transient");
    await waitFor(() => releases.includes("control-1"));

    expect(tokens).toEqual([{ name: "fleet", token: "session-token-1" }]);
    expect(registerCount).toBe(1);
    expect(releases).toEqual(["control-1"]);
  });

  it("keeps resubscribing after repeated transient disconnects instead of going degraded", async () => {
    let callStreamCount = 0;
    const manager = createGatewayDedicatedSessionManager({
      name: "fleet",
      lifecycle: { ensureDaemon: async () => "http://127.0.0.1:37283/mcp" } as never,
      readBootstrapToken: async () => "bootstrap",
      sleep: async () => undefined,
      registry: {
        getAllAgentTools: () => [{ id: "ping", description: "Ping", parameters: {} }],
        invoke: vi.fn(),
      } as never,
      fetch: (async (url: string | URL | Request) => {
        const target = String(url);
        if (target.endsWith("/admin/register")) {
          return jsonResponse({
            tenantId: "tenant-1",
            sessionId: "session-1",
            endpoint: "http://127.0.0.1:37283/mcp",
            controlToken: "control-1",
            sessionToken: "session-token-1",
            observerToken: "observer-1",
          });
        }
        if (target.endsWith("/control/calls")) {
          callStreamCount += 1;
          // 처음 6회는 연결 직후 끊기는 transient 스트림, 이후 유지되는 스트림
          return callStreamCount <= 6
            ? new Response(closedStream(), { status: 200 })
            : new Response(new ReadableStream(), { status: 200 });
        }
        if (target.endsWith("/control/release")) {
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      }) as typeof fetch,
    });

    await manager.issueSessionToken({ label: "agent:flaky", cwd: "/tmp/first" });
    await waitFor(() => callStreamCount >= 7);

    expect(manager.getConnectionState().state).not.toBe("degraded");
    manager.releaseSessionToken("agent:flaky");
  });

  it("posts an in-flight call result through the registration captured at delivery time", async () => {
    let registerCount = 0;
    let callStreamCount = 0;
    const releases: string[] = [];
    const order: string[] = [];
    const resultPosts: ResultPost[] = [];
    const invoke = vi.fn(async () => {
      await waitFor(() => registerCount >= 2);
      expect(releases).not.toContain("control-1");
      return { content: [{ type: "text", text: "pong" }], isError: false };
    });
    const manager = createGatewayDedicatedSessionManager({
      name: "fleet",
      lifecycle: { ensureDaemon: async () => "http://127.0.0.1:37283/mcp" } as never,
      readBootstrapToken: async () => "bootstrap",
      sleep: async () => undefined,
      registry: {
        getAllAgentTools: () => [{ id: "ping", description: "Ping", parameters: {} }],
        invoke,
      } as never,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith("/admin/register")) {
          registerCount += 1;
          return jsonResponse({
            tenantId: `tenant-${registerCount}`,
            sessionId: `session-${registerCount}`,
            endpoint: "http://127.0.0.1:37283/mcp",
            controlToken: `control-${registerCount}`,
            sessionToken: `session-token-${registerCount}`,
            observerToken: `observer-${registerCount}`,
          });
        }
        if (target.endsWith("/control/calls")) {
          callStreamCount += 1;
          if (callStreamCount === 1) {
            return new Response(sseStream({
              callId: "call-refresh",
              sessionId: "session-1",
              toolName: "ping",
              args: {},
              createdAt: Date.now(),
            }), { status: 200 });
          }
          if (callStreamCount === 2) {
            return jsonResponse({ error: "Unauthorized" }, 401);
          }
          return new Response(new ReadableStream(), { status: 200 });
        }
        if (target.includes("/control/results/")) {
          order.push("result");
          resultPosts.push({
            callId: target.split("/").pop() ?? "",
            sessionId: JSON.parse(String(init?.body)).sessionId as string,
            token: authorizationToken(init),
          });
          return jsonResponse({ ok: true });
        }
        if (target.endsWith("/control/release")) {
          order.push(`release:${authorizationToken(init)}`);
          releases.push(authorizationToken(init));
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      }) as typeof fetch,
    });

    await manager.issueSessionToken({ label: "agent:refresh", cwd: "/tmp/first" });
    await waitFor(() => resultPosts.length === 1);
    await waitFor(() => releases.includes("control-1"));
    manager.releaseSessionToken("agent:refresh");

    expect(resultPosts).toEqual([{ callId: "call-refresh", sessionId: "session-1", token: "control-1" }]);
    expect(order.indexOf("result")).toBeLessThan(order.indexOf("release:control-1"));
    expect(registerCount).toBeGreaterThanOrEqual(2);
  });

  it("releases the previous registration immediately when refresh has no in-flight calls", async () => {
    let registerCount = 0;
    let callStreamCount = 0;
    const releases: string[] = [];
    const manager = createGatewayDedicatedSessionManager({
      name: "fleet",
      lifecycle: { ensureDaemon: async () => "http://127.0.0.1:37283/mcp" } as never,
      readBootstrapToken: async () => "bootstrap",
      sleep: async () => undefined,
      registry: {
        getAllAgentTools: () => [{ id: "ping", description: "Ping", parameters: {} }],
        invoke: vi.fn(),
      } as never,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith("/admin/register")) {
          registerCount += 1;
          return jsonResponse({
            tenantId: `tenant-${registerCount}`,
            sessionId: `session-${registerCount}`,
            endpoint: "http://127.0.0.1:37283/mcp",
            controlToken: `control-${registerCount}`,
            sessionToken: `session-token-${registerCount}`,
            observerToken: `observer-${registerCount}`,
          });
        }
        if (target.endsWith("/control/calls")) {
          callStreamCount += 1;
          if (callStreamCount === 2) {
            return jsonResponse({ error: "Unauthorized" }, 401);
          }
          return callStreamCount === 1
            ? new Response(closedStream(), { status: 200 })
            : new Response(new ReadableStream(), { status: 200 });
        }
        if (target.endsWith("/control/release")) {
          releases.push(authorizationToken(init));
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      }) as typeof fetch,
    });

    await manager.issueSessionToken({ label: "agent:no-inflight", cwd: "/tmp/first" });
    await waitFor(() => registerCount >= 2 && releases.includes("control-1"));
    manager.releaseSessionToken("agent:no-inflight");

    expect(callStreamCount).toBeGreaterThanOrEqual(2);
    expect(releases[0]).toBe("control-1");
  });

  it("releases a refreshed registration after an in-flight result publish fails", async () => {
    let registerCount = 0;
    let callStreamCount = 0;
    const releases: string[] = [];
    const resultPosts: ResultPost[] = [];
    const invoke = vi.fn(async () => {
      await waitFor(() => registerCount >= 2);
      expect(releases).not.toContain("control-1");
      return { content: [{ type: "text", text: "pong" }], isError: false };
    });
    const manager = createGatewayDedicatedSessionManager({
      name: "fleet",
      lifecycle: { ensureDaemon: async () => "http://127.0.0.1:37283/mcp" } as never,
      readBootstrapToken: async () => "bootstrap",
      sleep: async () => undefined,
      registry: {
        getAllAgentTools: () => [{ id: "ping", description: "Ping", parameters: {} }],
        invoke,
      } as never,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith("/admin/register")) {
          registerCount += 1;
          return jsonResponse({
            tenantId: `tenant-${registerCount}`,
            sessionId: `session-${registerCount}`,
            endpoint: "http://127.0.0.1:37283/mcp",
            controlToken: `control-${registerCount}`,
            sessionToken: `session-token-${registerCount}`,
            observerToken: `observer-${registerCount}`,
          });
        }
        if (target.endsWith("/control/calls")) {
          callStreamCount += 1;
          if (callStreamCount === 1) {
            return new Response(sseStream({
              callId: "call-fail-refresh",
              sessionId: "session-1",
              toolName: "ping",
              args: {},
              createdAt: Date.now(),
            }), { status: 200 });
          }
          if (callStreamCount === 2) {
            return jsonResponse({ error: "Unauthorized" }, 401);
          }
          return new Response(new ReadableStream(), { status: 200 });
        }
        if (target.includes("/control/results/")) {
          resultPosts.push({
            callId: target.split("/").pop() ?? "",
            sessionId: JSON.parse(String(init?.body)).sessionId as string,
            token: authorizationToken(init),
          });
          return jsonResponse({ ok: false }, 403);
        }
        if (target.endsWith("/control/release")) {
          releases.push(authorizationToken(init));
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      }) as typeof fetch,
    });

    await manager.issueSessionToken({ label: "agent:publish-fail", cwd: "/tmp/first" });
    await waitFor(() => resultPosts.length === 1 && releases.includes("control-1"));
    manager.releaseSessionToken("agent:publish-fail");

    expect(resultPosts).toEqual([{ callId: "call-fail-refresh", sessionId: "session-1", token: "control-1" }]);
    expect(manager.getConnectionState().message).toContain("Fleet Gateway result publish failed");
  });

  it("handles result publish failures without an unhandled rejection", async () => {
    const calls = createControlledGatewayCallStream();
    const resultPosts: string[] = [];
    const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "pong" }], isError: false }));
    const manager = createExecutorManager(calls, invoke, resultPosts, 403);

    await manager.createExecutorMcpSession({
      serverName: "fleet",
      specs: [{ id: "ping", description: "Ping", parameters: {} }],
      cwd: "/tmp/failure",
    });
    await waitFor(() => calls.ready);
    calls.emit({ callId: "call-fail", sessionId: "session-fail", toolName: "ping", args: {} });
    await waitFor(() => manager.getConnectionState().state === "retrying");

    expect(resultPosts).toEqual(["call-fail"]);
    expect(manager.getConnectionState().message).toContain("Fleet Gateway result publish failed");
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

function createExecutorManager(
  calls: ControlledGatewayCallStream,
  invoke: ReturnType<typeof vi.fn>,
  resultPosts: string[],
  resultStatus = 200,
) {
  return createGatewayDedicatedSessionManager({
    name: "fleet",
    lifecycle: { ensureDaemon: async () => "http://127.0.0.1:37283/mcp" } as never,
    readBootstrapToken: async () => "bootstrap",
    registry: {
      getAllAgentTools: () => [{ id: "ping", description: "Ping", parameters: {} }],
      invoke,
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
        return new Response(calls.stream(), { status: 200 });
      }
      if (target.includes("/control/results/")) {
        resultPosts.push(target.split("/").pop() ?? "");
        return jsonResponse({ ok: resultStatus === 200 }, resultStatus);
      }
      if (target.endsWith("/control/release")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    }) as typeof fetch,
  });
}

function createControlledGatewayCallStream(): ControlledGatewayCallStream {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    get ready() {
      return Boolean(controller);
    },
    emit(call) {
      if (!controller) throw new Error("Gateway call stream is not ready");
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...call, createdAt: Date.now() })}\n\n`));
    },
    stream() {
      return new ReadableStream<Uint8Array>({
        start(nextController) {
          controller = nextController;
        },
      });
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseStream(body: unknown): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(body)}\n\n`));
      controller.close();
    },
  });
}

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function authorizationToken(init: RequestInit | undefined): string {
  return String(init?.headers instanceof Headers ? init.headers.get("Authorization") : (init?.headers as Record<string, string>).Authorization).replace("Bearer ", "");
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}
