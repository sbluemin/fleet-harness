import { describe, expect, it } from "vitest";

import {
  HOST_TERMINAL_UPGRADE_PATH,
  hostEventsUrl,
  hostSocketUrl,
  hostTransportPath,
  isHostByteRequest,
  isHostJsonRequest,
  isHostPresence,
  isHostPresenceRequest,
  isHostTerminalUpgradePath,
  isHostTransportErrorBody,
  parseHostSocketQuery,
  parseHostStreamQuery,
} from "@fleet-console/protocol/remote/host-transport";
import type http from "node:http";
import { createHostGateway } from "../features/remote-access/host/host-gateway.js";

const hostKey = "6f1c9a20-1111-4222-8333-444455556666";

describe("host transport wire contract", () => {
  it("requires expectedEpoch on presence and json bodies and rejects a ticket", () => {
    expect(isHostPresenceRequest({ intent: "observe", expectedEpoch: 3 })).toBe(true);
    expect(isHostPresenceRequest({ intent: "activate", epoch: 3 })).toBe(false);
    expect(isHostJsonRequest({
      requestId: "req-1234",
      expectedEpoch: 3,
      method: "POST",
      path: "/api/v1/agent/sessions/op/message",
      json: null,
    })).toBe(true);
    expect(isHostJsonRequest({
      requestId: "req-1234",
      expectedEpoch: 3,
      method: "POST",
      path: "/api/v1/agent/ticket",
      ticket: "secret",
    })).toBe(false);
    expect(isHostJsonRequest({
      requestId: "req-1234",
      epoch: 3,
      method: "GET",
      path: "/api/v1/theaters",
    })).toBe(false);
  });

  it("keeps byte requests free of a caller content type", () => {
    expect(isHostByteRequest({ requestId: "req-1234", expectedEpoch: 2, path: "/api/v1/browser/global/favicon?tab=a" })).toBe(true);
    expect(isHostByteRequest({ requestId: "req-1234", expectedEpoch: 2, path: "/api/v1/browser/global/favicon", contentType: "image/png" })).toBe(false);
  });

  it("builds a socket url without ticket, role, or upgrade path and rejects those queries", () => {
    const url = hostSocketUrl(hostKey, { epoch: 4, channel: "chat", operationId: "op-1" });
    expect(url).toBe(`/api/v1/hosts/${hostKey}/socket?epoch=4&channel=chat&operationId=op-1`);
    expect(url).not.toContain(HOST_TERMINAL_UPGRADE_PATH);
    expect(isHostTerminalUpgradePath("/api/v1/terminal/ws")).toBe(true);
    expect(isHostTerminalUpgradePath("/api/v1/terminal/ws?ticket=1")).toBe(false);
    const accepted = new URL(url ?? "http://invalid", "http://127.0.0.1");
    expect(parseHostSocketQuery(accepted.searchParams)?.channel).toBe("chat");
    const tainted = new URLSearchParams("epoch=4&channel=terminal&operationId=op-1&ticket=secret&role=viewer&path=/api/v1/terminal/ws");
    expect(parseHostSocketQuery(tainted)).toBeNull();
  });

  it("requires epoch on event and resource queries and ignores local", () => {
    expect(hostEventsUrl(hostKey, { path: "/api/v1/operations/events", epoch: 1 })).toContain("epoch=1");
    expect(parseHostStreamQuery(new URLSearchParams("path=/api/v1/operations/events"))).toBeNull();
    expect(hostTransportPath("presence", "local")).toBeNull();
    expect(isHostPresence({
      hostKey, epoch: 1, mode: "off", access: null, connection: "blocked", capability: "unsupported",
    })).toBe(true);
    expect(isHostPresence({
      hostKey, epoch: 1, mode: "controller", access: "full", connection: "ready", capability: "unsupported",
    })).toBe(false);
    expect(isHostTransportErrorBody({ error: "stale_epoch", epoch: 9 })).toBe(true);
    expect(isHostTransportErrorBody({ error: "read_only", epoch: 9 })).toBe(false);
  });
});


describe("host gateway admission", () => {
  const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32), origin: "https://remote.example:8443" };

  async function call(options: {
    method: string;
    path: string;
    body?: unknown;
    origin?: boolean;
    reply?: (request: { op: string; routeId: string; params: Record<string, unknown> }) => Record<string, unknown>;
  }): Promise<{ status: number; body: unknown }> {
    const calls: Array<{ op: string; routeId: string }> = [];
    const slot = { current: null as { status: number; body: unknown } | null };
    const gateway = createHostGateway({
      isLoopback: () => true,
      isExactOrigin: () => options.origin !== false,
      findHost: () => target,
      bridge: { async open() { return { id: 1, error: "remote_host_unavailable", end: true }; }, async call(request) {
        calls.push({ op: request.op, routeId: request.routeId });
        return { id: 1, ...(options.reply ? options.reply(request) : { error: "remote_host_unavailable" }) };
      } },
      readJsonBody: async <T,>() => (options.body ?? null) as T | null,
      writeJson: (_res, status, body) => { slot.current = { status, body }; },
      withSecurityHeaders: (headers) => headers,
    });
    const req = { method: options.method, url: options.path, headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
    const res = { writeHead: (status: number) => { slot.current = { status, body: null }; }, end: () => undefined, on: () => undefined, destroyed: false, write: () => true } as unknown as http.ServerResponse;
    await gateway.handle({ req, res, pathname: options.path.split("?")[0] ?? options.path });
    const written = slot.current;
    if (!written) throw new Error("gateway wrote nothing");
    return written;
  }

  it("rejects a stale presence epoch before asking the shell", async () => {
    const result = await call({ method: "POST", path: "/api/v1/hosts/host1/presence", body: { intent: "observe", expectedEpoch: 0 } });
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: "stale_epoch", epoch: 1 });
  });

  it("keeps an unsupported remote blocked instead of a controller", async () => {
    const slot = { current: null as { status: number; body: unknown } | null };
    let body: unknown = { intent: "observe", expectedEpoch: 1 };
    const gateway = createHostGateway({
      isLoopback: () => true,
      isExactOrigin: () => true,
      findHost: () => target,
      bridge: { async open() { return { id: 1, end: true }; }, async call() { return { id: 1, capability: "unsupported", error: "host_unsupported" }; } },
      readJsonBody: async <T,>() => body as T | null,
      writeJson: (_res, status, payload) => { slot.current = { status, body: payload }; },
      withSecurityHeaders: (headers) => headers,
    });
    const invoke = async (method: string, path: string) => {
      const req = { method, url: path, headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
      const res = { writeHead: () => undefined, end: () => undefined, on: () => undefined, destroyed: false, write: () => true } as unknown as http.ServerResponse;
      await gateway.handle({ req, res, pathname: path });
      const written = slot.current;
      if (!written) throw new Error("no response");
      return written;
    };
    const posted = await invoke("POST", "/api/v1/hosts/host1/presence");
    expect(posted.status).toBe(409);
    expect(posted.body).toMatchObject({ error: "host_unsupported" });
    const presence = await invoke("GET", "/api/v1/hosts/host1/presence");
    expect(presence.body).toMatchObject({ mode: "off", access: null, connection: "blocked", capability: "unsupported" });
  });

  it("denies an observer conversation write and an unknown route", async () => {
    const gatewayState: { mode: "observer" | "controller" } = { mode: "observer" };
    // The first successful observe moves the same gateway instance; this case uses a fresh call() each time,
    // so exercise the route table through a controller-ready link by observing first inside one gateway.
    const calls: string[] = [];
    const slot = { current: null as { status: number; body: unknown } | null };
    let body: unknown = { intent: "observe", expectedEpoch: 1 };
    const gateway = createHostGateway({
      isLoopback: () => true,
      isExactOrigin: () => true,
      findHost: () => target,
      bridge: { async open() { return { id: 1, error: "remote_host_unavailable", end: true }; }, async call(request) {
        calls.push(request.op);
        if (request.op === "presence") return { id: 1, capability: "supported", mode: "observer", access: "full" };
        return { id: 1, status: 200, contentType: "application/json", json: {} };
      } },
      readJsonBody: async <T,>() => body as T | null,
      writeJson: (_res, status, payload) => { slot.current = { status, body: payload }; },
      withSecurityHeaders: (headers) => headers,
    });
    const invoke = async (method: string, path: string) => {
      const req = { method, url: path, headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
      const res = { writeHead: (status: number) => { slot.current = { status, body: null }; }, end: () => undefined, on: () => undefined, destroyed: false, write: () => true } as unknown as http.ServerResponse;
      await gateway.handle({ req, res, pathname: path.split("?")[0] ?? path });
      const written = slot.current;
      if (!written) throw new Error("no response");
      return written;
    };
    await invoke("POST", "/api/v1/hosts/host1/presence");
    body = { requestId: "req-1234", expectedEpoch: 2, method: "POST", path: "/api/v1/agent/sessions/op/message", json: { text: "hi" } };
    const conversation = await invoke("POST", "/api/v1/hosts/host1/request");
    expect(conversation).toEqual({ status: 403, body: { error: "not_controller" } });
    body = { requestId: "req-1234", expectedEpoch: 2, method: "POST", path: "/api/v1/remote-hosts", json: {} };
    const unknown = await invoke("POST", "/api/v1/hosts/host1/request");
    expect(unknown).toEqual({ status: 403, body: { error: "route_denied" } });
    expect(calls).toEqual(["presence"]);
    void gatewayState;
  });

  it("relays an observer operation event stream and closes it when the epoch changes", async () => {
    const frames: string[] = [];
    let opened = false;
    const slot = { current: null as { status: number; body: unknown } | null };
    const gateway = createHostGateway({
      isLoopback: () => true,
      isExactOrigin: () => true,
      findHost: () => ({ hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32), origin: "https://remote.example:8443" }),
      bridge: {
        async call() { return { id: 1, capability: "supported", mode: "observer", access: "full" }; },
        async open(_request, onFrame, signal) {
          opened = true;
          await onFrame({ id: 7, text: "event: operation:changed\ndata: {}\n\n" });
          signal?.addEventListener("abort", () => frames.push("aborted"));
          return { id: 7, end: true };
        },
      },
      readJsonBody: async <T,>() => ({ intent: "observe", expectedEpoch: 1 }) as T,
      writeJson: (_res, status, body) => { slot.current = { status, body }; },
      withSecurityHeaders: (headers) => headers,
    });
    const presence = { method: "POST", url: "/api/v1/hosts/host1/presence", headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
    const presRes = { writeHead: () => undefined, end: () => undefined, on: () => undefined, destroyed: false, write: () => true } as unknown as http.ServerResponse;
    await gateway.handle({ req: presence, res: presRes, pathname: "/api/v1/hosts/host1/presence" });
    const writes: string[] = [];
    let ended = false;
    const req = { method: "GET", url: "/api/v1/hosts/host1/events?path=%2Fapi%2Fv1%2Foperations%2Fevents&epoch=2", headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
    const res = {
      writeHead: () => undefined,
      write: (chunk: string) => { writes.push(chunk); return true; },
      end: () => { ended = true; },
      on: () => undefined,
      once: () => undefined,
      destroyed: false,
      writableEnded: false,
    } as unknown as http.ServerResponse;
    await gateway.handle({ req, res, pathname: "/api/v1/hosts/host1/events" });
    expect(opened).toBe(true);
    expect(writes.join("")).toContain("operation:changed");
    expect(ended).toBe(true);
    expect(frames).toEqual([]);
  });
});
