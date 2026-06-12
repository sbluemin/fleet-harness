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
        return jsonResponse({ ok: true });
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
