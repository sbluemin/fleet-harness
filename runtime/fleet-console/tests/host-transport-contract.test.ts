import http from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  DESKTOP_HOST_FRAME_MAX_CHARS,
  DESKTOP_HOST_TRANSPORT_EVENT,
  DESKTOP_HOST_TRANSPORT_EVENTS_PATH,
  DESKTOP_HOST_TRANSPORT_PATH,
  DESKTOP_HOST_TRANSPORT_RELAY_PATH,
  DESKTOP_HOST_UPLOAD_CHUNK_CHARS,
  type DesktopHostCommand,
} from "@fleet-console/protocol/desktop";
import { createHostWorkspace } from "../core/client/src/integration/host-workspace.js";
import { createRemoteHostDependencies } from "../core/client/src/integration/remote-host-transport.js";
import { createRemoteHostRuntime } from "../core/client/src/integration/remote-host-runtime.js";
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
  isHostPairRequest,
  isHostPresence,
  isHostPresenceRequest,
  isHostTerminalUpgradePath,
  isHostUploadRequest,
  HOST_UPLOAD_MAX_BYTES,
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
    expect(admitHostRoute({ kind: "json", method: "POST", path: "/plugins/objectives/decision/answer", mode: "controller" })).toMatchObject({ id: "decision-answer" });
    expect(admitHostRoute({ kind: "json", method: "POST", path: "/plugins/objectives/decision/answer", mode: "observer" })).toEqual({ error: "read_only" });
    expect(admitHostRoute({ kind: "json", method: "POST", path: "/plugins/objectives/commodore/ask/answer", mode: "controller" })).toMatchObject({ id: "commodore-ask-answer" });
    expect(admitHostRoute({ kind: "json", method: "POST", path: "/plugins/objectives/commodore/ask/answer", mode: "observer" })).toEqual({ error: "read_only" });
    expect(admitHostRoute({ kind: "json", method: "GET", path: "/api/v1/models/roster?target=launch", mode: "controller" })).toMatchObject({ id: "model-roster", path: "/api/v1/models/roster?target=launch" });
    expect(admitHostRoute({ kind: "json", method: "GET", path: "/api/v1/models/roster?target=agent", mode: "observer" })).toMatchObject({ id: "model-roster" });
    for (const path of ["/plugins/objectives/commodore/autonomy", "/plugins/objectives/commodore/directive", "/plugins/objectives/commodore/intel/add", "/plugins/objectives/commodore/intel/edit", "/plugins/objectives/commodore/intel/remove", "/plugins/objectives/commodore/clear", "/plugins/objectives/commodore/sources", "/plugins/objectives/commodore/retry", "/plugins/objectives/commodore/coordinates", "/plugins/objectives/commodore/commander", "/plugins/objectives/commodore/patrol", "/plugins/objectives/commodore/stop-at"]) {
      expect(admitHostRoute({ kind: "json", method: "POST", path, mode: "controller" })).toMatchObject({ method: "POST", path });
      expect(admitHostRoute({ kind: "json", method: "POST", path, mode: "observer" })).toEqual({ error: "read_only" });
    }
    expect(admitHostRoute({ kind: "json", method: "POST", path: "/api/v1/settings/global", mode: "controller" })).toEqual({ error: "route_denied" });
    expect(admitHostRoute({ kind: "json", method: "POST", path: "/plugins/objectives/commodore/autonomy/extra", mode: "controller" })).toEqual({ error: "route_denied" });
    expect(admitHostRoute({ kind: "upload", method: "POST", path: "/plugins/objectives/attachment/add?objectiveId=a&name=one.png", mode: "controller" })).toMatchObject({ id: "objective-attachment-add" });
    expect(admitHostRoute({ kind: "upload", method: "POST", path: "/api/v1/agent/attachments", mode: "observer" })).toEqual({ error: "read_only" });
    const upload = { requestId: "req-1234", expectedEpoch: 2, expectedInstanceId: instanceId, path: "/api/v1/agent/attachments", dataBase64: "YQ==" };
    expect(isHostUploadRequest(upload)).toBe(true);
    expect(isHostUploadRequest({ ...upload, contentType: "image/png" })).toBe(false);
    expect(isHostUploadRequest({ ...upload, dataBase64: "A".repeat(Math.ceil(HOST_UPLOAD_MAX_BYTES / 3) * 4 + 4) })).toBe(false);
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
    expect(isHostPairRequest({ expectedEpoch: 1, expectedInstanceId: instanceId })).toBe(true);
    expect(isHostPairRequest({ expectedEpoch: 1, expectedInstanceId: instanceId, token: "grant" })).toBe(false);
    expect(hostTransportPath("pair", hostKey)).toBe(`/api/v1/hosts/${hostKey}/pair`);
    expect(isHostTransportErrorBody({ error: "remote_link_required" })).toBe(true);
    expect(isHostTransportErrorBody({ error: "paired_device_limit" })).toBe(true);
    expect(isHostTransportErrorBody({ error: "stale_instance" })).toBe(true);
    expect(isHostTransportErrorBody({ error: "stale_instance", instanceId, epoch: 1 })).toBe(false);
    expect(isHostTransportErrorBody({ error: "read_only", epoch: 9 })).toBe(false);
  });
});


describe("host gateway admission", () => {
  const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32), origin: "https://remote.example:8443" };

  it("rejects a stale presence epoch before asking the shell", async () => {
    const slot = { current: null as { status: number; body: unknown } | null };
    let body: unknown = null;
    const calls: string[] = [];
    const gateway = createHostGateway({
      isLoopback: () => true,
      isExactOrigin: () => true,
      findHost: () => target,
      bridge: { async open() { return { id: 1, end: true }; }, async call(request) { calls.push(request.op); return { id: 1, error: "remote_host_unavailable" }; } },
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
    const boot = await invoke("GET", "/api/v1/hosts/host1/presence");
    const lifetime = (boot.body as { instanceId: string; epoch: number });
    body = { intent: "observe", expectedEpoch: 0, expectedInstanceId: lifetime.instanceId };
    const result = await invoke("POST", "/api/v1/hosts/host1/presence");
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: "stale_epoch", epoch: lifetime.epoch });
    expect(calls).toEqual([]);
  });

  it("keeps an unsupported remote blocked instead of a controller", async () => {
    const slot = { current: null as { status: number; body: unknown } | null };
    let body: unknown = null;
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
    const boot = await invoke("GET", "/api/v1/hosts/host1/presence");
    const lifetime = (boot.body as { instanceId: string }).instanceId;
    body = { intent: "observe", expectedEpoch: 1, expectedInstanceId: lifetime };
    const posted = await invoke("POST", "/api/v1/hosts/host1/presence");
    expect(posted.status).toBe(409);
    expect(posted.body).toMatchObject({ error: "host_unsupported" });
    const presence = await invoke("GET", "/api/v1/hosts/host1/presence");
    expect(presence.body).toMatchObject({ mode: "off", access: null, connection: "blocked", capability: "unsupported" });
  });

  it("pairs without activating and leaves a shell that cannot pair unsupported", async () => {
    const calls: { op: string; params: unknown }[] = [];
    const slot = { current: null as { status: number; body: unknown } | null };
    let body: unknown = null;
    let host = target;
    let pairMode: "off" | "controller" = "off";
    const gateway = createHostGateway({
      isLoopback: () => true,
      isExactOrigin: () => true,
      findHost: () => host,
      bridge: { async open() { return { id: 1, end: true }; }, async call(request) {
        calls.push({ op: request.op, params: request.params });
        if (request.op !== "pair") return { id: 1, capability: "supported", mode: "controller", access: "full" };
        if (request.params.token !== undefined) return { id: 1, error: "route_denied" };
        return pairMode === "controller"
          ? { id: 1, capability: "supported", mode: "controller" as const, access: "full" as const }
          : { id: 1, capability: "supported", mode: "off" as const, access: null };
      } },
      readJsonBody: async <T,>() => body as T | null,
      writeJson: (_res, status, payload) => { slot.current = { status, body: payload }; },
      withSecurityHeaders: (headers) => headers,
    });
    const invoke = async (method: string, path: string) => {
      const req = { method, url: path, headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
      const res = { writeHead: (status: number) => { slot.current = { status, body: null }; }, end: () => undefined, on: () => undefined, destroyed: false, write: () => true, writableEnded: false } as unknown as http.ServerResponse;
      await gateway.handle({ req, res, pathname: path.split("?")[0] ?? path });
      const written = slot.current;
      if (!written) throw new Error("no response");
      return written;
    };
    const boot = await invoke("GET", "/api/v1/hosts/host1/presence");
    const lifetime = (boot.body as { instanceId: string; epoch: number }).instanceId;
    expect((boot.body as { epoch: number; mode: string }).epoch).toBe(1);
    body = { expectedEpoch: 1, expectedInstanceId: lifetime, token: "grant-secret" };
    expect(await invoke("POST", "/api/v1/hosts/host1/pair")).toEqual({ status: 400, body: { error: "invalid_host_request" } });
    body = { expectedEpoch: 1, expectedInstanceId: lifetime };
    expect((await invoke("POST", "/api/v1/hosts/host1/pair")).status).toBe(204);
    expect(calls).toEqual([{ op: "pair", params: {} }]);
    expect(JSON.stringify(calls)).not.toContain("grant-secret");
    const stayed = await invoke("GET", "/api/v1/hosts/host1/presence");
    expect(stayed.body).toMatchObject({ epoch: 1, instanceId: lifetime, mode: "off", access: null, connection: "closed", capability: "supported" });
    body = { expectedEpoch: 1, expectedInstanceId: "bbbbbbbb-1111-4222-8333-444455556666" };
    expect(await invoke("POST", "/api/v1/hosts/host1/pair")).toEqual({ status: 409, body: { error: "stale_instance" } });
    expect(calls).toHaveLength(1);
    pairMode = "controller";
    body = { expectedEpoch: 1, expectedInstanceId: lifetime };
    expect(await invoke("POST", "/api/v1/hosts/host1/pair")).toEqual({ status: 409, body: { error: "remote_host_unavailable" } });
    expect((await invoke("GET", "/api/v1/hosts/host1/presence")).body).toMatchObject({ epoch: 1, mode: "off", access: null, capability: "supported" });
    pairMode = "off";
    calls.length = 0;
    const unsupported = createHostGateway({
      isLoopback: () => true,
      isExactOrigin: () => true,
      findHost: () => target,
      bridge: { async open() { return { id: 1, end: true }; }, async call() { return { id: 1, capability: "unsupported", error: "host_unsupported" }; } },
      readJsonBody: async <T,>() => body as T | null,
      writeJson: (_res, status, payload) => { slot.current = { status, body: payload }; },
      withSecurityHeaders: (headers) => headers,
    });
    const deniedRes = { writeHead: (status: number) => { slot.current = { status, body: null }; }, end: () => undefined, on: () => undefined, destroyed: false, write: () => true, writableEnded: false } as unknown as http.ServerResponse;
    const bootUnsupported = { method: "GET", url: "/api/v1/hosts/host1/presence", headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
    await unsupported.handle({ req: bootUnsupported, res: deniedRes, pathname: "/api/v1/hosts/host1/presence" });
    const unsupportedLifetime = (slot.current?.body as { instanceId: string }).instanceId;
    body = { expectedEpoch: 1, expectedInstanceId: unsupportedLifetime };
    const denied = { method: "POST", url: "/api/v1/hosts/host1/pair", headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
    await unsupported.handle({ req: denied, res: deniedRes, pathname: "/api/v1/hosts/host1/pair" });
    expect(slot.current).toEqual({ status: 409, body: { error: "host_unsupported" } });
    const after = { method: "GET", url: "/api/v1/hosts/host1/presence", headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
    await unsupported.handle({ req: after, res: deniedRes, pathname: "/api/v1/hosts/host1/presence" });
    expect(slot.current?.body).toMatchObject({ mode: "off", capability: "supported", connection: "closed" });
    host = { ...target, fingerprint: "CD".repeat(32) };
    body = { expectedEpoch: 1, expectedInstanceId: lifetime };
    const changed = await invoke("POST", "/api/v1/hosts/host1/pair");
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ error: "stale_epoch" });
    const finalPresence = await invoke("GET", "/api/v1/hosts/host1/presence");
    expect(finalPresence.body).toMatchObject({ mode: "off", access: null });
    expect((finalPresence.body as { mode: string }).mode).not.toBe("controller");
  });

  it("denies an observer conversation write and an unknown route", async () => {
    const gatewayState: { mode: "observer" | "controller" } = { mode: "observer" };
    // The first successful observe moves the same gateway instance; this case uses a fresh call() each time,
    // so exercise the route table through a controller-ready link by observing first inside one gateway.
    const calls: string[] = [];
    const slot = { current: null as { status: number; body: unknown } | null };
    let body: unknown = null;
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
    const boot = await invoke("GET", "/api/v1/hosts/host1/presence");
    const lifetime = (boot.body as { instanceId: string }).instanceId;
    body = { intent: "observe", expectedEpoch: 1, expectedInstanceId: lifetime };
    await invoke("POST", "/api/v1/hosts/host1/presence");
    body = { requestId: "req-1234", expectedEpoch: 2, expectedInstanceId: lifetime, method: "POST", path: "/api/v1/agent/sessions/op/message", json: { text: "hi" } };
    const conversation = await invoke("POST", "/api/v1/hosts/host1/request");
    expect(conversation).toEqual({ status: 403, body: { error: "not_controller" } });
    body = { requestId: "req-1234", expectedEpoch: 2, expectedInstanceId: lifetime, method: "POST", path: "/api/v1/remote-hosts", json: {} };
    const unknown = await invoke("POST", "/api/v1/hosts/host1/request");
    expect(unknown).toEqual({ status: 403, body: { error: "route_denied" } });
    body = { requestId: "req-1234", expectedEpoch: 2, expectedInstanceId: lifetime, path: "/api/v1/agent/attachments" };
    const upload = await invoke("POST", "/api/v1/hosts/host1/bytes");
    expect(upload).toEqual({ status: 403, body: { error: "route_denied" } });
    expect(calls).toEqual(["presence"]);
    void gatewayState;
  });

  it("relays an observer operation event stream and closes it when the epoch changes", async () => {
    const frames: string[] = [];
    let opened = false;
    let lifetime = "";
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
      readJsonBody: async <T,>() => ({ intent: "observe", expectedEpoch: 1, expectedInstanceId: lifetime }) as T,
      writeJson: (_res, status, body) => { slot.current = { status, body }; },
      withSecurityHeaders: (headers) => headers,
    });
    const bootReq = { method: "GET", url: "/api/v1/hosts/host1/presence", headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
    const bootRes = { writeHead: () => undefined, end: () => undefined, on: () => undefined, destroyed: false, write: () => true } as unknown as http.ServerResponse;
    await gateway.handle({ req: bootReq, res: bootRes, pathname: "/api/v1/hosts/host1/presence" });
    lifetime = (slot.current?.body as { instanceId: string }).instanceId;
    const presence = { method: "POST", url: "/api/v1/hosts/host1/presence", headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
    const presRes = { writeHead: () => undefined, end: () => undefined, on: () => undefined, destroyed: false, write: () => true } as unknown as http.ServerResponse;
    await gateway.handle({ req: presence, res: presRes, pathname: "/api/v1/hosts/host1/presence" });
    const writes: string[] = [];
    let ended = false;
    const req = { method: "GET", url: `/api/v1/hosts/host1/events?path=%2Fapi%2Fv1%2Foperations%2Fevents&epoch=2&instanceId=${lifetime}`, headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
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

  it("does not relay a previous gateway lifetime at the same epoch", async () => {
    const previous = "bbbbbbbb-1111-4222-8333-444455556666";
    const calls: string[] = [];
    const slot = { current: null as { status: number; body: unknown } | null };
    let body: unknown = null;
    const gateway = createHostGateway({
      isLoopback: () => true,
      isExactOrigin: () => true,
      findHost: () => target,
      bridge: { async open() { calls.push("open"); return { id: 1, end: true }; }, async call(request) {
        calls.push(request.op);
        if (request.op === "presence") return { id: 1, capability: "supported", mode: "controller", access: "full" };
        return { id: 1, status: 200, contentType: "application/json", json: {}, dataBase64: "YQ==" };
      } },
      readJsonBody: async <T,>() => body as T | null,
      writeJson: (_res, status, payload) => { slot.current = { status, body: payload }; },
      withSecurityHeaders: (headers) => headers,
    });
    const invoke = async (method: string, path: string) => {
      const req = { method, url: path, headers: {}, on: () => undefined } as unknown as http.IncomingMessage;
      const res = { writeHead: (status: number) => { slot.current = { status, body: null }; }, end: () => undefined, on: () => undefined, destroyed: false, write: () => true, writableEnded: false } as unknown as http.ServerResponse;
      await gateway.handle({ req, res, pathname: path.split("?")[0] ?? path });
      const written = slot.current;
      if (!written) throw new Error("no response");
      return written;
    };
    const boot = await invoke("GET", "/api/v1/hosts/host1/presence");
    const lifetime = (boot.body as { instanceId: string; epoch: number }).instanceId;
    expect(lifetime).not.toBe(previous);
    body = { intent: "activate", expectedEpoch: 1, expectedInstanceId: lifetime };
    expect((await invoke("POST", "/api/v1/hosts/host1/presence")).status).toBe(204);
    const current = await invoke("GET", "/api/v1/hosts/host1/presence");
    const epoch = (current.body as { epoch: number }).epoch;
    body = { intent: "observe", expectedEpoch: epoch, expectedInstanceId: previous };
    expect(await invoke("POST", "/api/v1/hosts/host1/presence")).toEqual({ status: 409, body: { error: "stale_instance" } });
    body = { requestId: "req-1234", expectedEpoch: epoch, expectedInstanceId: previous, method: "POST", path: "/api/v1/agent/sessions/op/message", json: { text: "old" } };
    expect(await invoke("POST", "/api/v1/hosts/host1/request")).toEqual({ status: 409, body: { error: "stale_instance" } });
    body = { requestId: "req-1234", expectedEpoch: epoch, expectedInstanceId: previous, path: "/plugins/file-explorer/files/image?path=one.png" };
    expect(await invoke("POST", "/api/v1/hosts/host1/bytes")).toEqual({ status: 409, body: { error: "stale_instance" } });
    const resource = `/api/v1/hosts/host1/resources?path=${encodeURIComponent("/plugins/file-explorer/files/image?path=one.png")}&epoch=${epoch}&instanceId=${previous}`;
    expect(await invoke("GET", resource)).toEqual({ status: 409, body: { error: "stale_instance" } });
    const events = `/api/v1/hosts/host1/events?path=${encodeURIComponent("/api/v1/operations/events")}&epoch=${epoch}&instanceId=${previous}`;
    expect(await invoke("GET", events)).toEqual({ status: 409, body: { error: "stale_instance" } });
    const written: Buffer[] = [];
    const socket = { write: (chunk: string | Buffer) => { written.push(Buffer.from(chunk)); return true; }, destroy: () => undefined };
    const req = { url: `/api/v1/hosts/host1/socket?epoch=${epoch}&instanceId=${previous}&channel=terminal&operationId=op-1`, headers: {}, socket: { remoteAddress: "127.0.0.1" } } as unknown as http.IncomingMessage;
    expect(gateway.upgrade({ req, socket: socket as unknown as import("node:stream").Duplex, head: Buffer.alloc(0), pathname: "/api/v1/hosts/host1/socket" })).toBe(true);
    expect(Buffer.concat(written).toString("utf8")).toContain('"error":"stale_instance"');
    expect(calls).toEqual(["presence"]);
  });

  it("relays a controller image upload and refuses the same body from an observer", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const slot = { current: null as { status: number; body: unknown } | null };
    let body: unknown = null;
    const gateway = createHostGateway({
      isLoopback: () => true,
      isExactOrigin: () => true,
      findHost: () => target,
      bridge: { async open() { return { id: 1, end: true }; }, async call(request) {
        calls.push({ op: request.op, params: request.params });
        if (request.op === "presence") {
          const intent = request.params.intent;
          const mode = intent === "activate" ? "controller" : "observer";
          return { id: 1, capability: "supported", mode, access: "full" };
        }
        return { id: 1, status: 200, contentType: "application/json", json: { id: "att-1" } };
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
    const boot = await invoke("GET", "/api/v1/hosts/host1/presence");
    const lifetime = (boot.body as { instanceId: string }).instanceId;
    body = { intent: "observe", expectedEpoch: 1, expectedInstanceId: lifetime };
    await invoke("POST", "/api/v1/hosts/host1/presence");
    body = { requestId: "req-1234", expectedEpoch: 2, expectedInstanceId: lifetime, path: "/plugins/objectives/attachment/add?objectiveId=a&name=one.png", dataBase64: "YQ==" };
    const denied = await invoke("POST", "/api/v1/hosts/host1/bytes");
    expect(denied).toEqual({ status: 403, body: { error: "read_only" } });
    expect(calls.map((entry) => entry.op)).toEqual(["presence"]);
    body = { intent: "activate", expectedEpoch: 2, expectedInstanceId: lifetime };
    expect((await invoke("POST", "/api/v1/hosts/host1/presence")).status).toBe(204);
    const current = await invoke("GET", "/api/v1/hosts/host1/presence");
    const epoch = (current.body as { epoch: number }).epoch;
    body = { requestId: "req-1234", expectedEpoch: epoch, expectedInstanceId: lifetime, path: "/api/v1/agent/attachments", dataBase64: "YQ==" };
    const uploaded = await invoke("POST", "/api/v1/hosts/host1/bytes");
    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({ json: { id: "att-1" }, instanceId: lifetime });
    const sent = calls.at(-1);
    expect(sent).toMatchObject({ op: "http", params: { method: "POST", path: "/api/v1/agent/attachments", dataBase64: "YQ==" } });
    expect(sent?.params).not.toHaveProperty("contentType");
    body = { requestId: "req-1234", expectedEpoch: epoch, expectedInstanceId: lifetime, method: "POST", path: "/plugins/objectives/objective/create", json: { title: "remote" } };
    expect((await invoke("POST", "/api/v1/hosts/host1/request")).status).toBe(200);
    body = { requestId: "req-1234", expectedEpoch: epoch, expectedInstanceId: lifetime, method: "DELETE", path: "/api/v1/agent/attachments/att-1" };
    expect((await invoke("POST", "/api/v1/hosts/host1/request")).status).toBe(200);
    expect(calls.filter((entry) => entry.op === "http").map((entry) => entry.params.method)).toEqual(["POST", "POST", "DELETE"]);
    await expectUploadWithinFrame();
  }, 60_000);

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
      const boot = await (await fetch(`${origin}/api/v1/hosts/host1/presence`, { headers: { origin } })).json() as { epoch: number; instanceId: string };
      const presence = await fetch(`${origin}/api/v1/hosts/host1/presence`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ intent: "activate", expectedEpoch: boot.epoch, expectedInstanceId: boot.instanceId }),
      });
      expect(presence.status).toBe(204);
      const current = await (await fetch(`${origin}/api/v1/hosts/host1/presence`, { headers: { origin } })).json() as { epoch: number; instanceId: string; mode: string };
      expect(current).toMatchObject({ mode: "controller", instanceId: boot.instanceId });
      let closedEarly = false;
      socket = new WebSocket(`${origin.replace("http", "ws")}/api/v1/hosts/host1/socket?epoch=${current.epoch}&instanceId=${current.instanceId}&channel=terminal&operationId=op-1`, { headers: { Origin: origin } });
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
      const boot = await (await fetch(`${origin}/api/v1/hosts/host1/presence`, { headers: { origin } })).json() as { epoch: number; instanceId: string };
      const presence = await fetch(`${origin}/api/v1/hosts/host1/presence`, {
        method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ intent: "activate", expectedEpoch: boot.epoch, expectedInstanceId: boot.instanceId }),
      });
      expect(presence.status).toBe(204);
      const current = await (await fetch(`${origin}/api/v1/hosts/host1/presence`, { headers: { origin } })).json() as { epoch: number; instanceId: string };
      const request = (method: string, path: string, json?: unknown, signal?: AbortSignal) => fetch(`${origin}/api/v1/hosts/host1/request`, {
        method: "POST", signal, headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: `req-${Math.random().toString(36).slice(2, 12)}`, expectedEpoch: current.epoch, expectedInstanceId: current.instanceId, method, path, ...(json === undefined ? {} : { json }) }),
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
      const events = await fetch(`${origin}/api/v1/hosts/host1/events?path=${encodeURIComponent("/api/v1/operations/events")}&epoch=${current.epoch}&instanceId=${current.instanceId}`, {
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

  /**
   * 실제 loopback 서버·Origin 판정·bridge·gateway·writeJson 바이트를 지나 공개 browser dependencies·runtime까지 간다.
   * 셸(Desktop)만 relay로 흉내 낸다. 오류 본문은 손으로 만들지 않는다.
   */
  it("sends the public error body for each shell failure and carries a not-paired observe to the browser runtime", async () => {
    const start = () => startHostHarness();

    // 브라우저 runtime: 실제 응답이 공개 error validator를 통과해야 정확한 코드가 HostView까지 간다.
    const browser = await start();
    const network = {
      fetch: ((path: string, init?: RequestInit) => fetch(`${browser.origin}${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: browser.origin } })) as typeof fetch,
      events: () => { throw new Error("unused"); },
      socket: () => { throw new Error("unused"); },
      origin: browser.origin,
    };
    const runtime = createRemoteHostRuntime(createRemoteHostDependencies("host1", "label", network));
    try {
      browser.relay.current = { error: "remote_host_not_paired" };
      await expect(runtime.observe(new AbortController().signal)).rejects.toThrow("remote_host_not_paired");
      expect(runtime.getSnapshot()).toMatchObject({ phase: "error", error: "remote_host_not_paired" });
    } finally {
      runtime.dispose();
      await browser.stop();
    }

    // 서로 다른 기전의 오류가 각자 정확한 wire 형태로 나간다: epoch는 stale_epoch에만, 나머지는 {error}만.
    const wire = await start();
    try {
      const presencePath = hostTransportPath("presence", "host1") ?? "";
      const requestPath = hostTransportPath("request", "host1") ?? "";
      const current = async (): Promise<{ epoch: number; instanceId: string }> => (await (await fetch(`${wire.origin}${presencePath}`, { headers: { origin: wire.origin } })).json()) as { epoch: number; instanceId: string };
      const post = async (path: string, body: unknown, origin = wire.origin): Promise<{ status: number; body: unknown }> => {
        const response = await fetch(`${wire.origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
      };
      const exact = (result: { status: number; body: unknown }, status: number, body: unknown): void => {
        expect(result.status).toBe(status);
        expect(result.body).toEqual(body);
        expect(isHostTransportErrorBody(result.body)).toBe(true);
      };
      const lifetime = await current();
      const observe = (epoch: number, instance = lifetime.instanceId) => ({ intent: "observe", expectedEpoch: epoch, expectedInstanceId: instance });

      wire.relay.current = { error: "remote_host_not_paired" };
      exact(await post(presencePath, observe(lifetime.epoch)), 401, { error: "remote_host_not_paired" });
      wire.relay.current = { error: "observer_only" };
      exact(await post(presencePath, { ...observe(lifetime.epoch), intent: "activate" }), 403, { error: "observer_only" });
      // 게이트웨이 자신의 판정: 낡은 epoch만 현재 세대를 싣고, 낡은 수명은 {error}뿐이다.
      exact(await post(presencePath, observe(lifetime.epoch + 5)), 409, { error: "stale_epoch", epoch: (await current()).epoch });
      exact(await post(presencePath, observe(lifetime.epoch, "00000000-1111-4222-8333-444455556666")), 409, { error: "stale_instance" });
      // 정확한 Origin이 아니면 게이트웨이가 닫는다.
      exact(await post(presencePath, observe(lifetime.epoch), "http://127.0.0.1:1"), 400, { error: "invalid_host_request" });

      // 제어 가능한 연결에서 원격 도달 실패는 일반 거절이다.
      wire.relay.current = { capability: "supported", mode: "controller", access: "full" };
      expect((await post(presencePath, { ...observe(lifetime.epoch), intent: "activate" })).status).toBe(204);
      const live = await current();
      const request = { requestId: "11111111-2222-4333-8444-555555555555", expectedEpoch: live.epoch, expectedInstanceId: live.instanceId, method: "GET", path: "/api/v1/theaters" };
      wire.relay.current = { error: "remote_host_unreachable" };
      exact(await post(requestPath, request), 409, { error: "remote_host_unreachable" });

      // 셸이 지원하지 않는다고 하면 막힌 연결이 되고, 그 연결의 요청은 {error}만 받는다.
      wire.relay.current = { capability: "unsupported", error: "host_unsupported" };
      exact(await post(presencePath, observe(live.epoch)), 409, { error: "host_unsupported" });
      const blocked = await current();
      exact(await post(requestPath, { ...request, expectedEpoch: blocked.epoch }), 409, { error: "host_inactive" });
    } finally {
      await wire.stop();
    }
  });

  /**
   * 사용자가 관찰 중인 호스트의 대화 행을 처음 누르는 순서: 이벤트 스트림이 열려 있고, 활성화가 epoch를 올린다. 그 직후 옛 scope의
   * 스냅샷 새로고침이 stale_epoch로 끝난다(활성화 자신이 만든 stale이다). 그 stale은 호스트 오류가 아니라 재탐색 신호여야 하고,
   * 활성화가 받은 새 presence는 버려지지 않아야 한다. 실제 gateway·bridge·runtime·workspace를 지나며 셸과 브라우저 EventSource,
   * presence 읽기의 도착 순서만 흉내 낸다(요청 순서를 타이밍이 아니라 구조로 고정한다).
   */
  it("opens the first conversation click on an observed host even when its own activation stales an older snapshot", async () => {
    const streams = new Set<number>();
    let mode = "observer";
    const gate = { hold: false, open: (): void => undefined, opened: Promise.resolve() };
    const answer = (command: DesktopHostCommand, origin: string): void => {
      const path = String(command.params.path ?? "");
      const json = path === "/api/v1/theaters" ? { theaters: [{ id: "th1", label: "T" }] }
        : path === "/api/v1/operations" ? { operations: [{ id: "op1", theaterId: "th1", title: "O", type: "agent" }] }
          : path.startsWith("/api/v1/agent/sessions") ? { sessions: [] } : {};
      void postHostRelay(origin, { id: command.id, status: 200, contentType: "application/json", json });
    };
    const harness = await startHostHarness((command, origin) => {
      if (command.op === "sse") { streams.add(command.id); return; }
      if (command.op === "http") { answer(command, origin); return; }
      if (command.op !== "presence") return;
      if (command.params.intent !== "activate") { void postHostRelay(origin, { id: command.id, capability: "supported", mode, access: "full" }); return; }
      // 활성화: presence 읽기는 옛 스냅샷의 stale이 처리될 때까지 쥐어 두고, epoch를 올린 뒤 열린 스트림이 새로고침을 일으키게 한다.
      mode = "controller";
      gate.hold = true;
      gate.opened = new Promise<void>((resolve) => { gate.open = resolve; });
      void postHostRelay(origin, { id: command.id, capability: "supported", mode, access: "full" })
        .then(() => delay(15))
        .then(() => { for (const id of streams) void postHostRelay(origin, { id, text: "event: operation:changed\ndata: {}\n\n" }); });
    });
    const events: Array<{ close(): void }> = [];
    const network = {
      fetch: (async (path: string, init?: RequestInit) => {
        const isPresenceRead = path.endsWith("/presence") && (init?.method ?? "GET") === "GET";
        if (isPresenceRead && gate.hold) await gate.opened;
        const response = await fetch(`${harness.origin}${path}`, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: harness.origin } });
        // 옛 scope의 요청이 stale로 거절되어 runtime이 그것을 처리할 시간을 준 뒤에 presence 읽기를 풀어 준다.
        if (path.endsWith("/request") && response.status === 409 && gate.hold) setTimeout(() => { gate.hold = false; gate.open(); }, 30);
        return response;
      }) as typeof fetch,
      events: (path: string) => { const source = new FetchEventSource(`${harness.origin}${path}`, harness.origin); events.push(source); return source as unknown as EventSource; },
      socket: () => { throw new Error("unused"); },
      origin: harness.origin,
    };
    const runtime = createRemoteHostRuntime(createRemoteHostDependencies("host1", "label", network));
    const local = {
      getSnapshot: () => ({ hostKey: "local", label: "local", epoch: 1, instanceId: "local", mode: "controller", access: "full", connection: "ready", trust: "verified", phase: "ready", error: null, theaters: [], operations: [], objectives: [] }) as never,
      subscribe: () => () => undefined, observe: async () => undefined, activate: async () => undefined, dispose: () => undefined,
    };
    const workspace = createHostWorkspace(local);
    workspace.add(runtime);
    try {
      await runtime.observe(new AbortController().signal);
      runtime.setVisible(true);
      await waitUntil(() => streams.size >= 2, "the host event streams did not open");
      await delay(150);
      await workspace.activateConversation({ hostKey: "host1", theaterId: "th1", role: "commodore", operationId: null });
      expect(workspace.getSnapshot()).toMatchObject({ error: null, canWrite: true });
      expect(runtime.getSnapshot()).toMatchObject({ mode: "controller", connection: "ready", phase: "ready", error: null });
    } finally {
      for (const source of events) source.close();
      runtime.dispose();
      workspace.dispose();
      await harness.stop();
    }
  });
});

/** Node에는 브라우저 EventSource가 없다. 연결 열림·이벤트 이름 전달·자동 재연결만 흉내 낸다(응답 본문 모양은 gateway가 정한다). */
class FetchEventSource {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  private closed = false;
  private readonly abort = new AbortController();
  constructor(private readonly url: string, private readonly origin: string) { void this.run(); }
  addEventListener(name: string, listener: (event: unknown) => void): void { const set = this.listeners.get(name) ?? new Set(); set.add(listener); this.listeners.set(name, set); }
  removeEventListener(name: string, listener: (event: unknown) => void): void { this.listeners.get(name)?.delete(listener); }
  close(): void { this.closed = true; this.readyState = 2; this.abort.abort(); }
  private async run(): Promise<void> {
    while (!this.closed) {
      try {
        const response = await fetch(this.url, { headers: { origin: this.origin, accept: "text/event-stream" }, signal: this.abort.signal });
        if (!response.ok || !response.body) throw new Error(`status ${response.status}`);
        this.readyState = 1;
        this.onopen?.({});
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
            const name = /^event: (.+)$/mu.exec(frame)?.[1] ?? "message";
            const data = /^data: (.*)$/mu.exec(frame)?.[1] ?? "";
            for (const listener of this.listeners.get(name) ?? []) listener({ data });
          }
        }
      } catch { /* 닫혔거나 끊겼다 */ }
      if (this.closed) return;
      this.readyState = 0;
      this.onerror?.({});
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

/**
 * 실제 loopback 서버·Origin 판정·bridge·gateway·writeJson을 세우고, 셸(Desktop)만 relay로 흉내 낸다.
 * 기본 셸은 `relay.current`를 모든 명령의 응답으로 보낸다. `onCommand`를 주면 셸 동작을 그 함수가 정한다.
 */
async function startHostHarness(onCommand?: (command: DesktopHostCommand, origin: string) => void): Promise<{ origin: string; relay: { current: Record<string, unknown> }; stop: () => Promise<void> }> {
  const bridge = createHostShellBridge();
  const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32), origin: "https://remote.example:8443" };
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
  const relay = { current: {} as Record<string, unknown> };
  const shell = followHostCommands(origin, (command) => {
    if (onCommand) onCommand(command, origin);
    else void postHostRelay(origin, { id: command.id, ...relay.current });
  });
  await shell.attached;
  return { origin, relay, stop: async () => { shell.stop(); await closeServer(server); } };
}

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


async function expectUploadWithinFrame(): Promise<void> {
  const bridge = createHostShellBridge();
  const target = { hostname: "remote.example", port: 8443, fingerprint: "AB".repeat(32), origin: "https://remote.example:8443" };
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
  const remote: number[] = [];
  const assemblies = new Map<number, Buffer[]>();
  let maxFrame = 0;
  const heldAck: { current: (() => void) | null } = { current: null };
  let holdsLeft = 1;
  const firstChunk = deferred();
  let pauseNext = false;
  const paused = deferred();
  const shell = followHostCommands(origin, (command) => {
    if (command.op === "presence") {
      void postHostRelay(origin, { id: command.id, capability: "supported", mode: "controller", access: "full" });
      return;
    }
    if (command.op === "abort") {
      const uploadId = command.params.uploadId;
      if (typeof uploadId === "number") assemblies.delete(uploadId);
      void postHostRelay(origin, { id: command.id, end: true });
      return;
    }
    const upload = readCommandUpload(command);
    if (command.op === "http" && upload && typeof command.params.dataBase64 === "string") {
      expect(command.params.dataBase64.length).toBeLessThanOrEqual(DESKTOP_HOST_UPLOAD_CHUNK_CHARS);
      const parts = assemblies.get(upload.id) ?? [];
      parts[upload.index] = Buffer.from(command.params.dataBase64, "base64");
      assemblies.set(upload.id, parts);
      const ack = (): void => {
        if (upload.index + 1 < upload.count) void postHostRelay(origin, { id: command.id, uploadAck: upload.index });
        else {
          remote.push(Buffer.concat(parts).length);
          void postHostRelay(origin, { id: command.id, status: 201, contentType: "application/json", json: { id: "att-1" } });
        }
      };
      if (upload.index === 0 && holdsLeft > 0) {
        holdsLeft -= 1;
        heldAck.current = ack;
        firstChunk.resolve();
        return;
      }
      if (upload.index === 0 && pauseNext) {
        pauseNext = false;
        paused.resolve();
        return;
      }
      ack();
      return;
    }
    if (command.op === "http") {
      if (typeof command.params.dataBase64 === "string") remote.push(Buffer.from(command.params.dataBase64, "base64").length);
      void postHostRelay(origin, { id: command.id, status: 200, contentType: "application/json", json: { ok: true } });
    }
  }, undefined, (frame) => {
    expect(frame.length).toBeLessThanOrEqual(DESKTOP_HOST_FRAME_MAX_CHARS);
    maxFrame = Math.max(maxFrame, frame.length);
    const data = frame.split(/\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data.includes("upload")) return;
    const snapshot = JSON.parse(data) as { commands?: Array<{ params?: { upload?: unknown; dataBase64?: unknown } }> };
    const uploads = (snapshot.commands ?? []).filter((command) => command.params?.upload !== undefined);
    expect(uploads.length).toBeLessThanOrEqual(1);
  });
  try {
    await shell.attached;
    const boot = await (await fetch(`${origin}/api/v1/hosts/host1/presence`, { headers: { origin } })).json() as { epoch: number; instanceId: string };
    const activated = await fetch(`${origin}/api/v1/hosts/host1/presence`, {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ intent: "activate", expectedEpoch: boot.epoch, expectedInstanceId: boot.instanceId }),
    });
    expect(activated.status).toBe(204);
    const current = await (await fetch(`${origin}/api/v1/hosts/host1/presence`, { headers: { origin } })).json() as { epoch: number; instanceId: string };
    const send = (bytes: number, signal?: AbortSignal) => {
      const raw = Buffer.alloc(bytes, 0x61);
      return fetch(`${origin}/api/v1/hosts/host1/bytes`, {
        method: "POST", signal, headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ requestId: `req-${Math.random().toString(36).slice(2, 12)}`, expectedEpoch: current.epoch, expectedInstanceId: current.instanceId, path: "/api/v1/agent/attachments", dataBase64: raw.toString("base64") }),
      });
    };
    const full = send(HOST_UPLOAD_MAX_BYTES);
    await firstChunk.promise;
    const over = Math.ceil((DESKTOP_HOST_FRAME_MAX_CHARS + 1) / 4) * 3;
    const queued = send(over);
    const rejected = send(over);
    const early = await Promise.race([
      queued.then(async (response) => ({ response, other: rejected })),
      rejected.then(async (response) => ({ response, other: queued })),
    ]);
    expect(early.response.status).toBe(409);
    expect(await early.response.json()).toMatchObject({ error: "remote_host_unavailable" });
    const release = heldAck.current;
    heldAck.current = null;
    release?.();
    const completed = await Promise.all([full, early.other]);
    expect(completed[0].status).toBe(200);
    expect(await completed[0].json()).toMatchObject({ status: 201, json: { id: "att-1" } });
    expect(completed[1].status).toBe(200);
    expect(remote).toEqual([HOST_UPLOAD_MAX_BYTES, over]);
    expect(maxFrame).toBeGreaterThan(DESKTOP_HOST_UPLOAD_CHUNK_CHARS);
    expect(maxFrame).toBeLessThanOrEqual(DESKTOP_HOST_FRAME_MAX_CHARS);
    const snapshot = await (await fetch(`${origin}${DESKTOP_HOST_TRANSPORT_PATH}`, { headers: { origin } })).json() as { commands: unknown[] };
    expect(snapshot.commands).toEqual([]);
    pauseNext = true;
    const abort = new AbortController();
    const stopped = send(over, abort.signal);
    await paused.promise;
    abort.abort();
    await expect(stopped).rejects.toThrow();
    expect(remote).toEqual([HOST_UPLOAD_MAX_BYTES, over]);
    const again = await send(1);
    expect(again.status).toBe(200);
    expect(remote).toEqual([HOST_UPLOAD_MAX_BYTES, over, 1]);
    const after = await (await fetch(`${origin}${DESKTOP_HOST_TRANSPORT_PATH}`, { headers: { origin } })).json() as { commands: unknown[] };
    expect(after.commands).toEqual([]);
  } finally {
    heldAck.current?.();
    shell.stop();
    await closeServer(server);
  }
}

function readCommandUpload(command: DesktopHostCommand): { id: number; index: number; count: number } | null {
  const upload = command.params.upload;
  if (!upload || typeof upload !== "object" || Array.isArray(upload)) return null;
  const body = upload as { id?: unknown; index?: unknown; count?: unknown };
  if (typeof body.id !== "number" || typeof body.index !== "number" || typeof body.count !== "number") return null;
  return { id: body.id, index: body.index, count: body.count };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function followHostCommands(origin: string, onCommand: (command: DesktopHostCommand) => void, onLive?: (live: ReadonlySet<number>) => void, onFrame?: (frame: string) => void): { readonly attached: Promise<void>; stop(): void } {
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
            onFrame?.(frame);
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
