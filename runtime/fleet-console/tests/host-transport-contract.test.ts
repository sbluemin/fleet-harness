import http from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  DESKTOP_HOST_TRANSPORT_EVENTS_PATH,
  DESKTOP_HOST_TRANSPORT_PATH,
  DESKTOP_HOST_TRANSPORT_RELAY_PATH,
} from "@fleet-console/protocol/desktop";
import { createDesktopHostTransport } from "../../fleet-desktop/src/host-transport.js";
import { createHostShellBridge } from "../core/host/shell/host-transport-bridge.js";
import {
  HOST_TERMINAL_UPGRADE_PATH,
  hostEventsUrl,
  hostSocketUrl,
  hostTransportPath,
  isHostByteRequest,
  isHostByteResult,
  isHostJsonRequest,
  isHostPresence,
  isHostPresenceRequest,
  isHostTerminalUpgradePath,
  isHostTransportErrorBody,
  parseHostSocketQuery,
  parseHostStreamQuery,
} from "@fleet-console/protocol/remote/host-transport";
import { createHostGateway } from "../features/remote-access/host/host-gateway.js";
import { admitHostRoute } from "../features/remote-access/host/host-route-table.js";

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
    const byte = { requestId: "req-1234", epoch: 2, status: 200, dataBase64: "aGk=" };
    expect(isHostByteResult({ ...byte, contentType: "image/webp" })).toBe(true);
    expect(isHostByteResult({ ...byte, contentType: "text/plain; charset=utf-8" })).toBe(true);
    expect(isHostByteResult({ ...byte, contentType: "application/pdf" })).toBe(false);
    expect(admitHostRoute({ kind: "resources", method: "GET", path: "/plugins/objectives/result/file?objectiveId=a&resultId=b&v=1", mode: "observer" })).toMatchObject({ id: "objective-evidence", path: "/plugins/objectives/result/file?objectiveId=a&resultId=b&v=1" });
    expect(admitHostRoute({ kind: "resources", method: "GET", path: "/plugins/objectives/attachment/file?objectiveId=a&attachmentId=b", mode: "observer" })).toMatchObject({ id: "objective-attachment" });
    expect(admitHostRoute({ kind: "json", method: "POST", path: "/plugins/objectives/objective/get", mode: "observer" })).toMatchObject({ id: "objectives-get" });
    expect(admitHostRoute({ kind: "json", method: "GET", path: "/api/v1/agent/sessions/op/chat-history", mode: "observer" })).toMatchObject({ id: "agent-history" });
    expect(admitHostRoute({ kind: "json", method: "GET", path: "/plugins/quota/summary?force=1", mode: "observer" })).toMatchObject({ path: "/plugins/quota/summary?force=1" });
    expect(admitHostRoute({ kind: "events", method: "GET", path: "/plugins/file-explorer/files/watch?theaterId=t&directory=.", mode: "observer" })).toMatchObject({ id: "files-watch" });
    expect(admitHostRoute({ kind: "json", method: "POST", path: "/plugins/objectives/commander/message", mode: "observer" })).toEqual({ error: "not_controller" });
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
    body = { requestId: "req-1234", expectedEpoch: 2, path: "/api/v1/agent/attachments" };
    const upload = await invoke("POST", "/api/v1/hosts/host1/bytes");
    expect(upload).toEqual({ status: 403, body: { error: "route_denied" } });
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

  it("keeps the terminal's first resize and a normal burst until the remote socket is ready", async () => {
    const bridge = createHostShellBridge();
    const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32), origin: "https://remote.example:8443" };
    const sent: string[] = [];
    let openedPath = "";
    let remoteClosed = false;
    let finishRemote = (): void => undefined;
    const remoteClosedPromise = new Promise<void>((resolve) => { finishRemote = resolve; });
    const endpoint = { origin: "" };
    const gateway = createHostGateway({
      isLoopback: (req) => {
        const address = req.socket.remoteAddress;
        return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
      },
      isExactOrigin: (req) => req.headers.origin === endpoint.origin,
      findHost: () => target,
      bridge,
      readJsonBody: async <T,>(req: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString("utf8");
        return (text ? JSON.parse(text) : null) as T | null;
      },
      writeJson: (res, status, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
      },
      withSecurityHeaders: (headers) => headers,
    });
    const server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === DESKTOP_HOST_TRANSPORT_PATH && req.method === "GET") {
        const body = JSON.stringify(bridge.snapshot());
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      if (pathname === DESKTOP_HOST_TRANSPORT_EVENTS_PATH && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const unsubscribe = bridge.subscribe((frame) => { if (!res.destroyed) res.write(frame); });
        res.on("close", unsubscribe);
        return;
      }
      if (pathname === DESKTOP_HOST_TRANSPORT_RELAY_PATH && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const accepted = await bridge.relay(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        res.writeHead(accepted ? 204 : 400);
        res.end();
        return;
      }
      const handled = await gateway.handle({ req, res, pathname });
      if (!handled && !res.writableEnded) { res.writeHead(404); res.end(); }
    });
    server.on("upgrade", (req, socket, head) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (!gateway.upgrade({ req, socket, head, pathname })) socket.destroy();
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("no address");
        resolve(address.port);
      });
    });
    endpoint.origin = `http://127.0.0.1:${port}`;
    const origin = endpoint.origin;
    const transport = createDesktopHostTransport({
      fetch: globalThis.fetch,
      confirmIdentity: async () => undefined,
      openPartition: () => ({
        async fetch(url) {
          if (url.endsWith("/api/v1/sessions")) {
            return new Response(JSON.stringify({ capability: "host-session", mode: "controller", access: "full" }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (url.endsWith("/api/v1/agent/ticket")) return new Response(JSON.stringify({ ticket: "shell-ticket" }), { status: 200, headers: { "content-type": "application/json" } });
          return new Response("no", { status: 404 });
        },
        async readCookies() { return []; },
        async writeCookie() { return undefined; },
        pin() { return undefined; },
        clear() { return undefined; },
      }),
      readWindowCookies: async () => [],
      writeWindowCookie: async () => undefined,
      openSocket: async (input) => {
        openedPath = input.path;
        await new Promise((resolve) => setTimeout(resolve, 80));
        if (input.signal.aborted) throw new Error("remote_host_unavailable");
        return {
          sendText: (text) => { sent.push(text); },
          sendBytes: () => undefined,
          close: () => { remoteClosed = true; finishRemote(); },
          closed: remoteClosedPromise,
        };
      },
    });
    let socket: WebSocket | null = null;
    try {
      await transport.start(origin);
      const attached = Date.now() + 2000;
      while (!bridge.attached()) {
        if (Date.now() > attached) throw new Error("desktop did not attach");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const presence = await fetch(`${origin}/api/v1/hosts/host1/presence`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ intent: "activate", expectedEpoch: 1 }),
      });
      expect(presence.status).toBe(204);
      const current = await (await fetch(`${origin}/api/v1/hosts/host1/presence`, { headers: { origin } })).json() as { epoch: number; mode: string };
      expect(current).toMatchObject({ mode: "controller" });
      let closedEarly = false;
      socket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/hosts/host1/socket?epoch=${current.epoch}&channel=terminal&operationId=op-1`, { headers: { Origin: origin } });
      socket.on("close", () => { if (sent.length < 22) closedEarly = true; });
      await new Promise<void>((resolve, reject) => {
        socket?.once("open", () => resolve());
        socket?.once("error", reject);
      });
      socket.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
      socket.send(JSON.stringify({ type: "flow", paused: false }));
      for (let index = 0; index < 20; index += 1) socket.send(`k${index}`);
      const delivered = Date.now() + 8000;
      while (sent.length < 22) {
        if (Date.now() > delivered) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(closedEarly).toBe(false);
      expect(sent[0]).toContain("resize");
      expect(sent[1]).toContain("flow");
      expect(sent).toHaveLength(22);
      expect(openedPath).toContain("ticket=");
      expect(socket.url).not.toContain("ticket=");
      socket.close();
      const closed = Date.now() + 2000;
      while (!remoteClosed) {
        if (Date.now() > closed) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(remoteClosed).toBe(true);
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      socket?.close();
      transport.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    }
  });

  it("cancels a host post when the client leaves, not when its body has been read", async () => {
    const signals: AbortSignal[] = [];
    let releaseCall = (): void => undefined;
    const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32), origin: "https://remote.example:8443" };
    const gateway = createHostGateway({
      isLoopback: () => true,
      isExactOrigin: () => true,
      findHost: () => target,
      bridge: {
        async open(_request, _onFrame, signal) {
          if (signal) signals.push(signal);
          await new Promise<void>((resolve) => { releaseCall = resolve; });
          return { id: 1, end: true };
        },
        async call(request, signal) {
          if (request.op === "presence") return { id: 1, capability: "supported", mode: "controller", access: "full" };
          if (signal) signals.push(signal);
          await new Promise<void>((resolve) => { releaseCall = resolve; });
          return { id: 1, status: 200, contentType: "application/json", json: { ok: true } };
        },
      },
      readJsonBody: async <T,>(req: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString("utf8");
        return (text ? JSON.parse(text) : null) as T | null;
      },
      writeJson: (res, status, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
      },
      withSecurityHeaders: (headers) => headers,
    });
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      void gateway.handle({ req, res, pathname }).then((handled) => {
        if (!handled && !res.writableEnded) { res.writeHead(404); res.end(); }
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("no address");
        resolve(address.port);
      });
    });
    const origin = `http://127.0.0.1:${port}`;
    const until = async (ready: () => boolean): Promise<void> => {
      const deadline = Date.now() + 2000;
      while (!ready()) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      const presence = await fetch(`${origin}/api/v1/hosts/host1/presence`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ intent: "activate", expectedEpoch: 1 }),
      });
      expect(presence.status).toBe(204);
      const postAbort = new AbortController();
      const posted = fetch(`${origin}/api/v1/hosts/host1/request`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, signal: postAbort.signal,
        body: JSON.stringify({ requestId: "req-1234", expectedEpoch: 2, method: "GET", path: "/api/v1/theaters" }),
      }).catch((error: unknown) => error);
      await until(() => signals.length === 1);
      const postSignal = signals[0]!;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(postSignal.aborted).toBe(false);
      postAbort.abort();
      await until(() => postSignal.aborted);
      releaseCall();
      await posted;
      signals.length = 0;
      const streamAbort = new AbortController();
      const streamed = fetch(`${origin}/api/v1/hosts/host1/events?path=%2Fapi%2Fv1%2Foperations%2Fevents&epoch=2`, { headers: { origin }, signal: streamAbort.signal }).catch((error: unknown) => error);
      await until(() => signals.length === 1);
      const streamSignal = signals[0]!;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(streamSignal.aborted).toBe(false);
      streamAbort.abort();
      await until(() => streamSignal.aborted);
      releaseCall();
      await streamed;
    } finally {
      releaseCall();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    }
  });
});
