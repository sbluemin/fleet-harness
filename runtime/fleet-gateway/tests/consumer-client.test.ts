import { describe, expect, it, vi } from "vitest";

import type { GatewayQueuedToolCall } from "../src/api-types.js";
import { createGatewayConsumerClient } from "../src/consumer-client.js";

interface FetchRecord {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const REGISTRATION = {
  tenantId: "tenant-1",
  sessionId: "session-1",
  endpoint: "http://127.0.0.1:37283/mcp",
  controlToken: "control-token",
  sessionToken: "session-token",
  observerToken: "observer-token",
};

describe("gateway consumer client", () => {
  it("registers, executes streamed calls, publishes events, and releases", async () => {
    const calls: FetchRecord[] = [];
    const queuedCall: GatewayQueuedToolCall = {
      callId: "call-1",
      sessionId: "session-1",
      toolName: "ping",
      args: { value: 1 },
      createdAt: Date.now(),
    };
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "pong" }], isError: false }));
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/admin/register")) {
        return jsonResponse(REGISTRATION);
      }
      if (url.endsWith("/control/calls")) {
        return streamResponse([queuedCall]);
      }
      if (url.includes("/control/results/")) {
        return jsonResponse({ ok: true });
      }
      if (url.endsWith("/control/events")) {
        return jsonResponse({ ok: true, event: { id: 1 } });
      }
      if (url.endsWith("/control/release")) {
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const client = createGatewayConsumerClient({
      name: "tenant",
      cwd: "/work",
      lifecycle: { ensureDaemon: async () => "http://127.0.0.1:37283/mcp" },
      readBootstrapToken: async () => "bootstrap-token",
      fetch: fetchImpl,
      sleep: async () => undefined,
      executionPort: {
        listTools: () => [{ name: "ping", description: "Ping", inputSchema: {} }],
        execute,
      },
    });

    await expect(client.connect()).resolves.toEqual(REGISTRATION);
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
    client.publishEvent({ type: "job:start" });
    client.release();
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url.endsWith("/control/release"))).toBe(true);
    });

    expect(calls.find((call) => call.url.endsWith("/admin/register"))?.init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer bootstrap-token", "Content-Type": "application/json" },
    });
    expect(calls.some((call) => call.url.endsWith("/control/calls"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/control/results/call-1"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/control/events"))).toBe(true);
  });

  it("suppresses duplicate streamed calls", async () => {
    const queuedCall: GatewayQueuedToolCall = {
      callId: "call-1",
      sessionId: "session-1",
      toolName: "ping",
      args: {},
      createdAt: Date.now(),
    };
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "pong" }], isError: false }));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/admin/register")) return jsonResponse(REGISTRATION);
      if (url.endsWith("/control/calls")) return streamResponse([queuedCall, queuedCall]);
      if (url.includes("/control/results/")) return jsonResponse({ ok: true });
      if (url.endsWith("/control/release")) return jsonResponse({ ok: true });
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const client = createGatewayConsumerClient({
      name: "tenant",
      cwd: "/work",
      lifecycle: { ensureDaemon: async () => "http://127.0.0.1:37283/mcp" },
      readBootstrapToken: async () => "bootstrap-token",
      fetch: fetchImpl,
      sleep: async () => undefined,
      executionPort: {
        listTools: () => [{ name: "ping" }],
        execute,
      },
    });

    await client.connect();
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
    client.release();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function streamResponse(calls: readonly GatewayQueuedToolCall[]): Response {
  const encoder = new TextEncoder();
  const body = calls.map((call) => `data: ${JSON.stringify(call)}\n\n`).join("");
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
    },
    cancel: () => undefined,
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
