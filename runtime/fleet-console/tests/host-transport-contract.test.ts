import http from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  DESKTOP_HOST_TRANSPORT_EVENT,
  DESKTOP_HOST_TRANSPORT_EVENTS_PATH,
  DESKTOP_HOST_TRANSPORT_PATH,
  DESKTOP_HOST_TRANSPORT_RELAY_PATH,
  type DesktopHostCommand,
} from "@fleet-console/protocol/desktop";
import { createHostShellBridge } from "../core/host/shell/host-transport-bridge.js";
import {
  HOST_TERMINAL_UPGRADE_PATH,
  hostEventsUrl,
  hostResourcesUrl,
  hostSocketUrl,
  hostTransportPath,
  isHostByteRequest,
  isHostByteResult,
  isHostJsonRequest,
  isHostJsonResult,
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
const instanceId = "aaaaaaaa-1111-4222-8333-444455556666";

describe("host transport wire contract", () => {
  it("requires the gateway lifetime and epoch on bodies and results without admitting tickets", () => {
    expect(isHostPresenceRequest({ intent: "observe", expectedEpoch: 3, expectedInstanceId: instanceId })).toBe(true);
    expect(isHostPresenceRequest({ intent: "observe", expectedEpoch: 3 })).toBe(false);
    expect(isHostPresenceRequest({ intent: "activate", epoch: 3, expectedInstanceId: instanceId })).toBe(false);
    const request = { requestId: "req-1234", expectedEpoch: 3, expectedInstanceId: instanceId, method: "POST", path: "/api/v1/agent/sessions/op/message", json: null };
    expect(isHostJsonRequest(request)).toBe(true);
    expect(isHostJsonRequest({ ...request, expectedInstanceId: undefined })).toBe(false);
    expect(isHostJsonRequest({ ...request, ticket: "secret" })).toBe(false);
    const result = { requestId: "req-1234", epoch: 3, instanceId, status: 200, contentType: "application/json", json: {} };
    expect(isHostJsonResult(result)).toBe(true);
    expect(isHostJsonResult({ ...result, instanceId: undefined })).toBe(false);
  });

  it("keeps byte requests scoped and free of caller content types", () => {
    const request = { requestId: "req-1234", expectedEpoch: 2, expectedInstanceId: instanceId, path: "/api/v1/browser/global/favicon?tab=a" };
    expect(isHostByteRequest(request)).toBe(true);
    expect(isHostByteRequest({ ...request, expectedInstanceId: undefined })).toBe(false);
    expect(isHostByteRequest({ ...request, contentType: "image/png" })).toBe(false);
    const byte = { requestId: "req-1234", epoch: 2, instanceId, status: 200, contentType: "image/png", dataBase64: "aGk=" };
    expect(isHostByteResult(byte)).toBe(true);
    expect(isHostByteResult({ ...byte, contentType: "image/webp" })).toBe(true);
    expect(isHostByteResult({ ...byte, contentType: "text/plain; charset=utf-8" })).toBe(true);
    expect(isHostByteResult({ ...byte, contentType: "application/pdf" })).toBe(false);
    expect(isHostByteResult({ ...byte, instanceId: undefined })).toBe(false);
    expect(admitHostRoute({ kind: "resources", method: "GET", path: "/plugins/objectives/result/file?objectiveId=a&resultId=b&v=1", mode: "observer" })).toMatchObject({ id: "objective-evidence", path: "/plugins/objectives/result/file?objectiveId=a&resultId=b&v=1" });
    expect(admitHostRoute({ kind: "resources", method: "GET", path: "/plugins/objectives/attachment/file?objectiveId=a&attachmentId=b", mode: "observer" })).toMatchObject({ id: "objective-attachment" });
    expect(admitHostRoute({ kind: "json", method: "POST", path: "/plugins/objectives/objective/get", mode: "observer" })).toMatchObject({ id: "objectives-get" });
    expect(admitHostRoute({ kind: "json", method: "GET", path: "/api/v1/agent/sessions/op/chat-history", mode: "observer" })).toMatchObject({ id: "agent-history" });
    expect(admitHostRoute({ kind: "json", method: "GET", path: "/plugins/quota/summary?force=1", mode: "observer" })).toMatchObject({ path: "/plugins/quota/summary?force=1" });
    expect(admitHostRoute({ kind: "events", method: "GET", path: "/plugins/file-explorer/files/watch?theaterId=t&directory=.", mode: "observer" })).toMatchObject({ id: "files-watch" });
    expect(admitHostRoute({ kind: "json", method: "POST", path: "/plugins/objectives/commander/message", mode: "observer" })).toEqual({ error: "not_controller" });
  });

  it("binds sockets to a lifetime without ticket, role, or upgrade path", () => {
    const url = hostSocketUrl(hostKey, { epoch: 4, instanceId, channel: "chat", operationId: "op-1" });
    expect(url).toBe(`/api/v1/hosts/${hostKey}/socket?epoch=4&instanceId=${instanceId}&channel=chat&operationId=op-1`);
    expect(url).not.toContain(HOST_TERMINAL_UPGRADE_PATH);
    expect(isHostTerminalUpgradePath("/api/v1/terminal/ws")).toBe(true);
    expect(isHostTerminalUpgradePath("/api/v1/terminal/ws?ticket=1")).toBe(false);
    const accepted = new URL(url!, "http://127.0.0.1");
    expect(parseHostSocketQuery(accepted.searchParams)).toMatchObject({ instanceId, epoch: 4, channel: "chat" });
    accepted.searchParams.delete("instanceId");
    expect(parseHostSocketQuery(accepted.searchParams)).toBeNull();
    accepted.searchParams.set("instanceId", instanceId);
    accepted.searchParams.set("ticket", "secret");
    expect(parseHostSocketQuery(accepted.searchParams)).toBeNull();
  });

  it("fences event/resource queries and discovers lifetime only through presence", () => {
    const query = { path: "/api/v1/operations/events", epoch: 1, instanceId };
    const events = new URL(hostEventsUrl(hostKey, query)!, "http://127.0.0.1");
    expect(parseHostStreamQuery(events.searchParams)).toEqual(query);
    expect(hostResourcesUrl(hostKey, { ...query, path: "/plugins/file-explorer/files/image?path=one.png" })).toContain(`instanceId=${instanceId}`);
    events.searchParams.append("instanceId", instanceId);
    expect(parseHostStreamQuery(events.searchParams)).toBeNull();
    expect(parseHostStreamQuery(new URLSearchParams("path=/api/v1/operations/events&epoch=1"))).toBeNull();
    expect(hostTransportPath("presence", "local")).toBeNull();
    const presence = { hostKey, epoch: 1, instanceId, mode: "off", access: null, connection: "blocked", capability: "unsupported" };
    expect(isHostPresence(presence)).toBe(true);
    expect(isHostPresence({ ...presence, instanceId: "not-a-lifetime" })).toBe(false);
    expect(isHostPresence({ ...presence, mode: "controller", access: "full", connection: "ready" })).toBe(false);
    expect(isHostTransportErrorBody({ error: "stale_epoch", epoch: 9 })).toBe(true);
    expect(isHostTransportErrorBody({ error: "stale_instance" })).toBe(true);
    expect(isHostTransportErrorBody({ error: "stale_instance", instanceId, epoch: 1 })).toBe(false);
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
    // Gateway and bridge over the public desktop host-transport protocol, not the shell executor.
    const bridge = createHostShellBridge();
    const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32), origin: "https://remote.example:8443" };
    const sent: string[] = [];
    let remoteClosed = false;
    let heldUntilReady = false;
    const endpoint = { origin: "" };
    const gateway = createHostGateway({
      isLoopback: (req) => {
        const address = req.socket.remoteAddress;
        return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
      },
      isExactOrigin: (req) => req.headers.origin === endpoint.origin,
      findHost: () => target,
      bridge,
      readJsonBody: readJson,
      writeJson,
      withSecurityHeaders: (headers) => headers,
    });
    const server = hostTransportServer(bridge, gateway);
    const port = await listen(server);
    endpoint.origin = `http://127.0.0.1:${port}`;
    const origin = endpoint.origin;
    const shell = followHostCommands(origin, (command) => {
      if (command.op === "presence") void postHostRelay(origin, { id: command.id, capability: "supported", mode: "controller", access: "full" });
      if (command.op === "ws-open") {
        void delay(80).then(() => {
          heldUntilReady = sent.length === 0;
          return postHostRelay(origin, { id: command.id, ready: true });
        });
      }
      if (command.op === "ws-send" && typeof command.params.text === "string") {
        sent.push(command.params.text);
        void postHostRelay(origin, { id: command.id, end: true });
      }
      if (command.op === "ws-close") {
        remoteClosed = true;
        void postHostRelay(origin, { id: command.id, end: true });
      }
    });
    let socket: WebSocket | null = null;
    try {
      await shell.attached;
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
      await waitUntil(() => sent.length >= 22, "terminal frames were not relayed");
      expect(closedEarly).toBe(false);
      expect(heldUntilReady).toBe(true);
      expect(sent[0]).toContain("resize");
      expect(sent[1]).toContain("flow");
      expect(sent).toHaveLength(22);
      expect(socket.url).not.toContain("ticket=");
      socket.close();
      await waitUntil(() => remoteClosed, "terminal close was not commanded");
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      socket?.close();
      shell.stop();
      await closeServer(server);
    }
  });

  it("cancels a host post when the client leaves, not when its body has been read", async () => {
    // A short subscription gap keeps the bridge command, and a client leaving a POST publishes abort.
    // Cancelling the remote fetch and retrying a rejected relay are the desktop representative test.
    const held = createHostShellBridge({ detachMs: 200 });
    const stopHolding = held.subscribe(() => undefined);
    const heldOpen = held.open({
      hostKey: "host1", epoch: 1, op: "sse", routeId: "operation-events",
      target: { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32) },
      params: { path: "/api/v1/operations/events" },
    }, () => undefined);
    stopHolding();
    await delay(80);
    expect(held.snapshot().commands).toHaveLength(1);
    await delay(250);
    expect(held.snapshot().commands).toHaveLength(0);
    await heldOpen;

    const bridge = createHostShellBridge();
    const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32), origin: "https://remote.example:8443" };
    const endpoint = { origin: "" };
    const eventResponses = new Set<http.ServerResponse>();
    const gateway = createHostGateway({
      isLoopback: (req) => {
        const address = req.socket.remoteAddress;
        return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
      },
      isExactOrigin: (req) => req.headers.origin === endpoint.origin,
      findHost: () => target,
      bridge,
      readJsonBody: readJson,
      writeJson,
      withSecurityHeaders: (headers) => headers,
    });
    const server = hostTransportServer(bridge, gateway, eventResponses);
    const port = await listen(server);
    endpoint.origin = `http://127.0.0.1:${port}`;
    const origin = endpoint.origin;
    const live = new Set<number>();
    const seenHttp = new Map<string, number>();
    const abortTargets: number[] = [];
    let theatersStillLive = false;
    let messageId = 0;
    let messageStarted = 0;
    let messageWait = 0;
    let sseId = 0;
    const timers: ReturnType<typeof setInterval>[] = [];
    const shell = followHostCommands(origin, (command) => {
      if (command.op === "presence") void postHostRelay(origin, { id: command.id, capability: "supported", mode: "controller", access: "full" });
      if (command.op === "abort" && typeof command.params.commandId === "number") {
        abortTargets.push(command.params.commandId);
        if (command.params.commandId === messageId && messageStarted > 0) messageWait = performance.now() - messageStarted;
        void postHostRelay(origin, { id: command.id, end: true });
      }
      if (command.op === "http" && command.params.path === "/api/v1/theaters") {
        seenHttp.set("theaters", (seenHttp.get("theaters") ?? 0) + 1);
        void delay(80).then(async () => {
          theatersStillLive = live.has(command.id) && !abortTargets.includes(command.id);
          await postHostRelay(origin, { id: command.id, status: 200, contentType: "application/json", json: { theaters: [{ id: "kept" }] } });
        });
      }
      if (command.op === "http" && command.params.path === "/api/v1/agent/sessions/op1/message") {
        seenHttp.set("message", (seenHttp.get("message") ?? 0) + 1);
        messageId = command.id;
        messageStarted = performance.now();
      }
      if (command.op === "sse") {
        sseId = command.id;
        const timer = setInterval(() => {
          if (!live.has(command.id)) { clearInterval(timer); return; }
          void postHostRelay(origin, { id: command.id, text: "event: operation:changed\ndata: {}\n\n" });
        }, 100);
        timers.push(timer);
      }
    }, (current) => {
      live.clear();
      for (const id of current) live.add(id);
    });
    const streamAbort = new AbortController();
    try {
      await shell.attached;
      const presence = await fetch(`${origin}/api/v1/hosts/host1/presence`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ intent: "activate", expectedEpoch: 1 }),
      });
      expect(presence.status).toBe(204);
      const current = await (await fetch(`${origin}/api/v1/hosts/host1/presence`, { headers: { origin } })).json() as { epoch: number };
      const request = (method: string, path: string, json?: unknown, signal?: AbortSignal) => fetch(`${origin}/api/v1/hosts/host1/request`, {
        method: "POST", signal, headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: `req-${Math.random().toString(36).slice(2, 12)}`, expectedEpoch: current.epoch, method, path, ...(json === undefined ? {} : { json }) }),
      });
      const read = await request("GET", "/api/v1/theaters");
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ status: 200, json: { theaters: [{ id: "kept" }] } });
      expect(seenHttp.get("theaters")).toBe(1);
      expect(theatersStillLive).toBe(true);

      const postAbort = new AbortController();
      const posted = request("POST", "/api/v1/agent/sessions/op1/message", { text: "x" }, postAbort.signal).catch((error: unknown) => error);
      await waitUntil(() => messageId !== 0, "message was not commanded");
      await delay(200);
      expect(abortTargets.includes(messageId)).toBe(false);
      postAbort.abort();
      await posted;
      await waitUntil(() => abortTargets.includes(messageId), "message abort was not commanded");
      expect(seenHttp.get("message")).toBe(1);
      expect(messageWait).toBeGreaterThan(0);
      expect(messageWait).toBeLessThan(1500);

      let frames = 0;
      let ended = false;
      const events = await fetch(`${origin}/api/v1/hosts/host1/events?path=${encodeURIComponent("/api/v1/operations/events")}&epoch=${current.epoch}`, {
        headers: { origin }, signal: streamAbort.signal,
      });
      const reader = events.body?.getReader();
      if (!reader) throw new Error("no event body");
      const pump = (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) { ended = true; break; }
            frames += 1;
          }
        } catch { ended = true; }
      })();
      await waitUntil(() => frames >= 2, "event stream did not start");
      const beforeDrop = frames;
      for (const response of [...eventResponses]) response.destroy();
      await delay(1600);
      expect(frames).toBeGreaterThan(beforeDrop);
      expect(ended).toBe(false);
      expect(eventResponses.size).toBe(1);
      expect(bridge.snapshot().commands.some((command) => command.id === sseId && command.op === "sse")).toBe(true);
      streamAbort.abort();
      await pump;
      await waitUntil(() => abortTargets.includes(sseId), "event abort was not commanded");
    } finally {
      streamAbort.abort();
      for (const timer of timers) clearInterval(timer);
      shell.stop();
      await closeServer(server);
    }
  });
});

function hostTransportServer(bridge: ReturnType<typeof createHostShellBridge>, gateway: { handle(context: { req: http.IncomingMessage; res: http.ServerResponse; pathname: string }): Promise<boolean>; upgrade?(context: { req: http.IncomingMessage; socket: import("node:stream").Duplex; head: Buffer; pathname: string }): boolean }, eventResponses?: Set<http.ServerResponse>): http.Server {
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
      eventResponses?.add(res);
      const unsubscribe = bridge.subscribe((frame) => { if (!res.destroyed) res.write(frame); });
      res.on("close", () => { eventResponses?.delete(res); unsubscribe(); });
      return;
    }
    if (pathname === DESKTOP_HOST_TRANSPORT_RELAY_PATH && req.method === "POST") {
      const body = await readJson<unknown>(req);
      const accepted = await bridge.relay(body);
      res.writeHead(accepted ? 204 : 400);
      res.end();
      return;
    }
    const handled = await gateway.handle({ req, res, pathname });
    if (!handled && !res.writableEnded) { res.writeHead(404); res.end(); }
  });
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (!gateway.upgrade?.({ req, socket, head, pathname })) socket.destroy();
  });
  return server;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function readJson<T>(req: http.IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return (text ? JSON.parse(text) : null) as T | null;
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function followHostCommands(origin: string, onCommand: (command: DesktopHostCommand) => void, onLive?: (live: ReadonlySet<number>) => void): { readonly attached: Promise<void>; stop(): void } {
  const controller = new AbortController();
  const seen = new Set<number>();
  let stopped = false;
  let resolveAttached = (): void => undefined;
  const attached = new Promise<void>((resolve) => { resolveAttached = resolve; });
  const consume = (commands: readonly DesktopHostCommand[]): void => {
    resolveAttached();
    const live = new Set(commands.map((command) => command.id));
    onLive?.(live);
    for (const command of commands) {
      if (seen.has(command.id)) continue;
      seen.add(command.id);
      onCommand(command);
    }
  };
  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        const response = await fetch(`${origin}${DESKTOP_HOST_TRANSPORT_EVENTS_PATH}`, {
          headers: { accept: "text/event-stream", origin },
          signal: controller.signal,
        });
        if (!response.body) throw new Error("no events");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffered += decoder.decode(chunk.value, { stream: true });
          const frames = buffered.split(/\n\n/u);
          buffered = frames.pop() ?? "";
          for (const frame of frames) {
            if (!frame.includes(DESKTOP_HOST_TRANSPORT_EVENT)) continue;
            const data = frame.split(/\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const snapshot = JSON.parse(data) as { commands?: DesktopHostCommand[] };
            consume(snapshot.commands ?? []);
          }
        }
      } catch {
        if (stopped) return;
      }
      if (!stopped) await delay(25);
    }
  };
  void run();
  return { attached, stop() { stopped = true; controller.abort(); } };
}

function postHostRelay(origin: string, body: unknown): Promise<void> {
  return fetch(`${origin}${DESKTOP_HOST_TRANSPORT_RELAY_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  }).then(() => undefined, () => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUntil(ready: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4000;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (ready()) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error(label)); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}
