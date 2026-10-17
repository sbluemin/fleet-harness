import { describe, expect, it, vi } from "vitest";
import type { HostSelection, HostView } from "@fleet-console/sdk/host-context";
import { createHostWorkspace, type HostRuntimePort } from "../core/client/src/integration/host-workspace.js";
import { createRemoteHostDependencies, createRemoteHostTransport } from "../core/client/src/integration/remote-host-transport.js";
import { createRemoteHostRuntime, type HostPresenceView } from "../core/client/src/integration/remote-host-runtime.js";
import type { HostEventSource } from "@fleet-console/sdk/host-context";

import { encodeAccessLink, parseAccessLink, type ValidatedAccessLink } from "../features/remote-access/host/access-link.js";
import { createRemoteHostStore, type RemoteHostStoreDeps } from "../features/remote-access/host/remote-hosts.js";

const INSTANCE_A = "aaaaaaaa-1111-4222-8333-444455556666";
const INSTANCE_B = "bbbbbbbb-1111-4222-8333-444455556666";

const FINGERPRINT_A = "8D3FBB2A855053305C32280A2ABB566FFF9C5B14C353AE0527092ED476CBB70F";
const FINGERPRINT_B = "11223344556677889900AABBCCDDEEFF11223344556677889900AABBCCDDEEFF";
const TOKEN_A = "sEPaty9_Yzq-N46FjCUfme4_DrCZeYlTitGcbWd8kLA";
const TOKEN_B = "Xy1_pQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQr";

function link(overrides: { endpoint?: string; token?: string; fingerprint?: string; label?: string } = {}): ValidatedAccessLink {
  return parseAccessLink(encodeAccessLink({
    endpoint: overrides.endpoint ?? "https://100.84.12.7:6768",
    token: overrides.token ?? TOKEN_A,
    fingerprint: overrides.fingerprint ?? FINGERPRINT_A,
    label: overrides.label ?? "devbox",
  }));
}

/** 디스크 대신 맵에 쓴다 — 저장된 바이트를 그대로 들여다보기 위해서다. */
function createHarness(start = 10_000) {
  const files = new Map<string, string>();
  let current = start;
  let counter = 0;
  const deps: RemoteHostStoreDeps = {
    ensureDirectory: () => undefined,
    readFile: (file: string) => {
      const found = files.get(file);
      if (found === undefined) throw new Error("ENOENT");
      return found;
    },
    fileSystem: {
      writeFileSync: ((file: string, content: string) => { files.set(file, content); }) as never,
      renameSync: ((from: string, to: string) => {
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      }) as never,
    },
    now: () => current,
    randomId: () => `host-${++counter}`,
  };
  return {
    deps,
    files,
    advance: (ms: number) => { current += ms; },
    stored: () => files.get("/console/remote/known-hosts.json") ?? "",
    open: () => createRemoteHostStore("/console", deps),
  };
}

function runtime(hostKey: string, access: HostView["access"] = "full") {
  let state: HostView = { hostKey, label: hostKey, epoch: 1, connection: "ready", trust: "verified", access, mode: "observer", phase: "ready", error: null, theaters: [{ id: "same-theater", label: hostKey }], operations: [{ id: "same-operation", theaterId: "same-theater", title: hostKey, type: "agent" }] };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<HostView>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const port: HostRuntimePort = {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    observe: vi.fn(async () => undefined),
    activate: vi.fn(async () => { update({ mode: "controller" }); }),
    dispose: vi.fn(),
  };
  return { port, update };
}

const selection = (hostKey: string): HostSelection => ({ hostKey, theaterId: "same-theater", role: "commander", operationId: "same-operation" });

// 기존 저장 host 검증은 화면 전환을 거치지 않는다. 같은 id와 늦은 획득 결과의 교차 host 입력 방어를 이 경계에서 검사한다.
describe("host workspace isolation", () => {
  // 기존 관찰/획득 검사는 신뢰 연결을 거치지 않는다. 공개 UI 포트부터 local gateway까지 비제어·단일 소비·취소 경계를 검사한다.
  it("pairs once into observation without changing foreground or following cancelled and stale handoffs", async () => {
    function fixture() {
      let server: HostPresenceView & { capability: "supported" } = { hostKey: "remote", epoch: 1, instanceId: INSTANCE_A, mode: "off", access: null, connection: "closed", capability: "supported" };
      let finish!: (response: Response) => void;
      let observeError: string | null = null;
      let paired = false;
      const calls: Array<{ path: string; body: Record<string, unknown> | null; signal: AbortSignal | null | undefined }> = [];
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
        calls.push({ path, body, signal: init?.signal });
        if (path === "/api/v1/hosts/remote/pair") {
          expect(body).toEqual({ expectedEpoch: 1, expectedInstanceId: INSTANCE_A });
          expect(init?.redirect).toBe("error");
          return new Promise<Response>((resolve) => { finish = resolve; });
        }
        if (path === "/api/v1/hosts/remote/presence") {
          if (body) {
            expect(body).toEqual({ intent: "observe", expectedEpoch: 1, expectedInstanceId: INSTANCE_A });
            if (body.expectedInstanceId !== server.instanceId) return Response.json({ error: "stale_instance" }, { status: 409 });
            if (observeError || !paired) return Response.json({ error: observeError ?? "remote_host_not_paired" }, { status: 401 });
            server = { ...server, epoch: 2, mode: "observer", access: "full", connection: "ready" };
            return new Response(null, { status: 204 });
          }
          return Response.json(server);
        }
        if (path === "/api/v1/hosts/remote/request" && body) return Response.json({ requestId: body.requestId, epoch: server.epoch, instanceId: server.instanceId, status: 200, contentType: "application/json", json: body.path === "/api/v1/theaters" ? { theaters: [] } : body.path === "/api/v1/operations" ? { operations: [] } : { sessions: [] } });
        throw new Error("unexpected_network_path");
      });
      const remote = createRemoteHostRuntime(createRemoteHostDependencies("remote", "Remote", { fetch, origin: "http://127.0.0.1:1234", events: () => { throw new Error("unexpected_events"); }, socket: () => { throw new Error("unexpected_socket"); } }));
      const workspace = createHostWorkspace(runtime("local").port); workspace.add(remote);
      return { remote, workspace, calls, finish: (response = new Response(null, { status: 204 })) => { if (response.status === 204) paired = true; finish(response); }, restart: () => { server = { ...server, instanceId: INSTANCE_B }; }, rejectObserve: () => { observeError = "remote_host_not_paired"; } };
    }
    const h = fixture();
    try {
      // 앱에 새 host가 등록됐을 때와 같은 초기 관찰이다. 오류를 snapshot에 미리 심지 않는다.
      await expect(h.remote.observe(new AbortController().signal)).rejects.toThrow("remote_host_not_paired");
      expect(h.remote.getSnapshot()).toMatchObject({ mode: "off", connection: "blocked", phase: "error", error: "remote_host_not_paired" });
      h.calls.length = 0;
      const before = h.workspace.getSnapshot();
      const first = h.workspace.pair("remote", new AbortController().signal);
      const second = h.workspace.pair("remote", new AbortController().signal);
      await vi.waitFor(() => expect(h.calls.filter((call) => call.path.endsWith("/pair"))).toHaveLength(1));
      h.finish(); await Promise.all([first, second]);
      expect(h.remote.getSnapshot()).toMatchObject({ epoch: 2, instanceId: INSTANCE_A, mode: "observer", phase: "ready" });
      expect(h.workspace.getSnapshot()).toMatchObject({ selection: before.selection, foreground: before.foreground, selectionGeneration: before.selectionGeneration, canWrite: before.canWrite });
      expect(h.calls.filter((call) => call.body?.intent)).toHaveLength(1);
    } finally { h.workspace.dispose(); }

    const cancelled = fixture();
    try {
      const abort = new AbortController();
      const result = cancelled.workspace.pair("remote", abort.signal);
      const rejected = expect(result).rejects.toThrow();
      await vi.waitFor(() => expect(cancelled.calls.some((call) => call.path.endsWith("/pair"))).toBe(true));
      abort.abort(); cancelled.finish(); await rejected;
      expect(cancelled.calls.find((call) => call.path.endsWith("/pair"))?.signal?.aborted).toBe(true);
      expect(cancelled.calls.some((call) => call.body?.intent)).toBe(false);
      expect(cancelled.remote.getSnapshot().mode).toBe("off");
    } finally { cancelled.workspace.dispose(); }

    const replaced = fixture();
    try {
      const result = replaced.workspace.pair("remote", new AbortController().signal);
      const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(replaced.calls.some((call) => call.path.endsWith("/pair"))).toBe(true));
      replaced.workspace.remove("remote");
      const next = runtime("remote"); next.update({ instanceId: INSTANCE_A });
      replaced.workspace.add(next.port);
      // 같은 id·instance의 주소 교체라도 이전 전송이 늦게 낸 실패는 새 카드의 오류가 아니다.
      replaced.finish(Response.json({ error: "remote_host_unavailable" }, { status: 409 }));
      await rejected;
      expect(replaced.workspace.getSnapshot().hosts.find((host) => host.hostKey === "remote")).toMatchObject({ instanceId: INSTANCE_A, phase: "ready", error: null });
      expect(replaced.calls.some((call) => call.body?.intent)).toBe(false);
    } finally { replaced.workspace.dispose(); }

    const lateSuccess = createHostWorkspace(runtime("local").port);
    try {
      let finish!: () => void;
      const old = runtime("remote"); old.update({ instanceId: INSTANCE_A });
      lateSuccess.add({ ...old.port, pair: () => new Promise<void>((resolve) => { finish = resolve; }) });
      const result = lateSuccess.pair("remote", new AbortController().signal);
      const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      lateSuccess.remove("remote");
      const next = runtime("remote"); next.update({ instanceId: INSTANCE_A });
      lateSuccess.add(next.port);
      finish(); await rejected;
      expect(lateSuccess.getSnapshot().hosts.find((host) => host.hostKey === "remote")).toMatchObject({ instanceId: INSTANCE_A, phase: "ready", error: null });
    } finally { lateSuccess.dispose(); }

    const stale = fixture();
    try {
      const result = stale.workspace.pair("remote", new AbortController().signal);
      const rejected = expect(result).rejects.toThrow("stale_instance");
      await vi.waitFor(() => expect(stale.calls.some((call) => call.path.endsWith("/pair"))).toBe(true));
      stale.restart(); stale.finish(); await rejected;
      expect(stale.remote.getSnapshot()).toMatchObject({ instanceId: INSTANCE_A, mode: "off" });
      expect(stale.calls.filter((call) => call.path.endsWith("/pair"))).toHaveLength(1);
    } finally { stale.workspace.dispose(); }

    const unsupported = fixture();
    try {
      const result = unsupported.workspace.pair("remote", new AbortController().signal);
      const rejected = expect(result).rejects.toMatchObject({ name: "HostTransportFailure", message: "host_unsupported", status: 409 });
      await vi.waitFor(() => expect(unsupported.calls.some((call) => call.path.endsWith("/pair"))).toBe(true));
      unsupported.finish(Response.json({ error: "host_unsupported" }, { status: 409 })); await rejected;
      expect(unsupported.calls.some((call) => call.body?.intent)).toBe(false);
      expect(unsupported.remote.getSnapshot()).toMatchObject({ mode: "off", connection: "closed", error: null });
      const retry = unsupported.workspace.pair("remote", new AbortController().signal);
      const failedObserve = expect(retry).rejects.toThrow("remote_host_not_paired");
      await vi.waitFor(() => expect(unsupported.calls.filter((call) => call.path.endsWith("/pair"))).toHaveLength(2));
      unsupported.rejectObserve(); unsupported.finish(); await failedObserve;
      expect(unsupported.calls.filter((call) => call.path.endsWith("/pair"))).toHaveLength(2);
      expect(unsupported.calls.filter((call) => call.body?.intent)).toHaveLength(1);
    } finally { unsupported.workspace.dispose(); }
  });

  it("keeps background hosts stream-free and closes both viewer streams before parking", async () => {
    const sources: Array<{ close: ReturnType<typeof vi.fn>; listeners: Map<string, (event: { data: string }) => void> }> = [];
    const request = vi.fn(async (path: string) => new Response(JSON.stringify(path === "/api/v1/theaters" ? { theaters: [{ id: "same-theater", label: "remote" }] } : path === "/api/v1/operations" ? { operations: [{ id: "same-operation", theaterId: "same-theater", title: "remote", type: "agent" }] } : { sessions: [] })));
    const remote = createRemoteHostRuntime({
      hostKey: "remote", label: "remote",
      readPresence: async () => ({ hostKey: "remote", epoch: 1, instanceId: INSTANCE_A, mode: "observer", access: "monitoring", connection: "ready" }),
      changePresence: async () => { throw new Error("unexpected_join"); },
      watchPresence: () => () => undefined,
      createTransport: (scope) => ({ scope, request, resourceUrl: (path) => path, socket: () => { throw new Error("unexpected_socket"); }, events: () => {
        const source = { close: vi.fn(), listeners: new Map<string, (event: { data: string }) => void>() };
        sources.push(source);
        return { ...source, readyState: 1, onopen: null, onmessage: null, onerror: null, addEventListener: (name: string, callback: (event: { data: string }) => void) => source.listeners.set(name, callback), removeEventListener: () => undefined } as unknown as HostEventSource;
      } }),
    });
    await remote.observe(new AbortController().signal);
    expect(sources).toHaveLength(0);
    remote.setVisible(true);
    expect(sources).toHaveLength(2);
    remote.setVisible(false);
    expect(sources.every((source) => source.close.mock.calls.length === 1)).toBe(true);
    const count = request.mock.calls.length;
    sources[0]!.listeners.get("operation:changed")?.({ data: "{}" });
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(count);
    expect(remote.getSnapshot().mode).toBe("observer");
    remote.dispose();
  });

  it("recovers a restarted gateway without accepting old discovery or reviving write authority", async () => {
    let server: HostPresenceView = { hostKey: "remote", epoch: 3, instanceId: INSTANCE_A, mode: "observer", access: "full", connection: "ready" };
    const watches: Array<{ receive: (presence: HostPresenceView) => void | Promise<void>; off: ReturnType<typeof vi.fn> }> = [];
    const read = vi.fn(async () => ({ ...server }));
    const change = vi.fn(async (intent: "observe" | "activate", epoch: number, instanceId: string) => {
      if (instanceId !== server.instanceId) throw new Error("stale_instance");
      if (epoch !== server.epoch) throw new Error("stale_epoch");
      server = { ...server, epoch: epoch + 1, mode: intent === "activate" ? "controller" : "observer", access: "full", connection: "ready" };
      return { ...server };
    });
    const remote = createRemoteHostRuntime({ hostKey: "remote", label: "remote", readPresence: read, changePresence: change,
      watchPresence: (receive) => { const watch = { receive, off: vi.fn() }; watches.push(watch); return watch.off; },
      createTransport: (scope) => ({ scope, resourceUrl: (path) => path, socket: () => { throw new Error("unexpected_socket"); },
        events: () => ({ close() {}, onopen: null, onmessage: null, onerror: null, readyState: 1, addEventListener() {}, removeEventListener() {} }),
        request: async (path) => Response.json(path === "/api/v1/theaters" ? { theaters: [{ id: "same-theater", label: "remote" }] } : path === "/api/v1/operations" ? { operations: [{ id: "same-operation", theaterId: "same-theater", title: "remote", type: "agent" }] } : { sessions: [] }),
      }),
    });
    const workspace = createHostWorkspace(runtime("local").port); workspace.add(remote);
    await workspace.activateConversation(selection("remote"));
    expect(workspace.getSnapshot().canWrite).toBe(true);
    const oldScope = remote.getTransport()!.scope;
    const oldWatch = watches.at(-1)!;
    let release!: (presence: HostPresenceView) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const late = oldWatch.receive({ ...server });
    const oldReply = { ...server };
    server = { ...server, instanceId: INSTANCE_B, epoch: 1, mode: "off", access: null, connection: "closed" };
    await remote.observe(new AbortController().signal);
    expect(remote.getSnapshot()).toMatchObject({ instanceId: INSTANCE_B, epoch: 2, phase: "ready", mode: "observer" });
    expect(oldScope.signal.aborted).toBe(true);
    expect(workspace.getSnapshot().canWrite).toBe(false);
    release(oldReply); await late;
    const calls = read.mock.calls.length;
    await oldWatch.receive(oldReply);
    expect(read).toHaveBeenCalledTimes(calls);
    expect(remote.getSnapshot().instanceId).toBe(INSTANCE_B);
    // 같은 수명의 뒤늦은 ready/controller 관측도 낮은 epoch로 현재 상태를 바꾸지 않는다.
    read.mockResolvedValueOnce({ ...server, epoch: 1, mode: "controller" });
    await watches.at(-1)!.receive(server);
    expect(remote.getSnapshot()).toMatchObject({ epoch: 2, mode: "observer" });
    await workspace.activateConversation(selection("remote"));
    expect(workspace.getSnapshot().canWrite).toBe(true);
    server = { ...server, instanceId: "cccccccc-1111-4222-8333-444455556666" };
    await watches.at(-1)!.receive(server);
    expect(remote.getSnapshot().epoch).toBe(server.epoch);
    expect(workspace.getSnapshot()).toMatchObject({ foreground: selection("remote"), canWrite: false });
    const sameEpochOld = { ...server };
    read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const sameEpochLate = watches.at(-1)!.receive(server);
    server = { ...server, mode: "observer" };
    await watches.at(-1)!.receive(server);
    release(sameEpochOld); await sameEpochLate;
    expect(remote.getSnapshot()).toMatchObject({ instanceId: server.instanceId, epoch: server.epoch, mode: "observer" });
    workspace.dispose();
    expect(watches.every((watch) => watch.off.mock.calls.length === 1)).toBe(true);
  });

  it("selects verified unstarted objectives without inventing operations and revokes deleted selections", async () => {
    let presence: HostPresenceView = { hostKey: "remote", epoch: 1, instanceId: INSTANCE_A, mode: "observer", access: "full", connection: "ready" };
    let objective = { id: "new-goal", theaterId: "same-theater", title: "New goal", commander: { started: false } };
    const frames = new Map<string, (event: { data: string }) => void>();
    const remote = createRemoteHostRuntime({ hostKey: "remote", label: "remote",
      readPresence: async () => presence,
      changePresence: async () => (presence = { ...presence, epoch: presence.epoch + 1, mode: "controller" }),
      watchPresence: () => () => undefined,
      createTransport: (scope) => ({ scope, resourceUrl: (path) => path, socket: () => { throw new Error("unexpected_socket"); },
        events: () => ({ close() {}, onopen: null, onmessage: null, onerror: null, readyState: 1, addEventListener: (name: string, callback: (event: { data: string }) => void) => frames.set(name, callback), removeEventListener() {} }) as unknown as HostEventSource,
        request: async (path) => Response.json(path === "/plugins/objectives/objective/get" ? { objective } : path === "/api/v1/theaters" ? { theaters: [{ id: "same-theater", label: "Remote" }] } : path === "/api/v1/operations" ? { operations: [] } : { sessions: [] }),
      }),
    });
    const workspace = createHostWorkspace(runtime("local").port); workspace.add(remote);
    const target = { hostKey: "remote", theaterId: "same-theater", role: "commander", operationId: "new-goal" } as const;
    await expect(workspace.activateConversation(target)).rejects.toThrow("host_selection_missing");
    await workspace.activateObjective(target);
    expect(workspace.getSnapshot()).toMatchObject({ foreground: target, canWrite: true });
    expect(remote.getSnapshot().operations).toEqual([]);
    expect(remote.getSnapshot().objectives).toEqual([{ id: "new-goal", theaterId: "same-theater", title: "New goal", started: false }]);
    remote.setVisible(true);
    frames.get("objectives:objective")!({ data: JSON.stringify({ op: "remove", theaterId: "same-theater", objectiveId: "new-goal" }) });
    expect(workspace.getSnapshot()).toMatchObject({ foreground: null, canWrite: false });
    objective = { ...objective, theaterId: "another-theater" };
    await expect(workspace.activateObjective(target)).rejects.toThrow("host_selection_missing");
    workspace.dispose();
  });

  it("binds HTTP and resource requests to the expected host epoch without credential or local fallback", async () => {
    const abort = new AbortController();
    let responseEpoch = 7;
    let responseInstance = INSTANCE_A;
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)) as { requestId: string };
      return new Response(JSON.stringify({ requestId: input.requestId, epoch: responseEpoch, instanceId: responseInstance, status: 403, contentType: "application/json", json: { error: "read_only" } }), { headers: { "Content-Type": "application/json" } });
    });
    const transport = createRemoteHostTransport({ hostKey: "remote", epoch: 7, instanceId: INSTANCE_A, signal: abort.signal }, {
      fetch: request,
      events: () => { throw new Error("unexpected_event_source"); },
      socket: () => { throw new Error("unexpected_socket"); },
      origin: "http://127.0.0.1:1234",
    });
    const response = await transport.request("/api/v1/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: "same-theater" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "read_only" });
    expect(request.mock.calls[0]?.[0]).toBe("/api/v1/hosts/remote/request");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ expectedEpoch: 7, expectedInstanceId: INSTANCE_A, method: "POST", path: "/api/v1/operations", json: { theaterId: "same-theater" } });
    expect(transport.resourceUrl("/plugins/objectives/evidence/read?id=one")).toContain("epoch=7");
    await expect(transport.request("https://other.example/api/v1/operations")).rejects.toThrow("invalid_host_request");
    await expect(transport.request("/api/v1/operations", { headers: { Authorization: "secret" } })).rejects.toThrow("invalid_host_request");
    expect(request).toHaveBeenCalledTimes(1);
    responseEpoch = 8;
    await expect(transport.request("/api/v1/operations")).rejects.toThrow("stale_epoch");
    expect(request).toHaveBeenCalledTimes(2);
    responseEpoch = 7; responseInstance = INSTANCE_B;
    await expect(transport.request("/api/v1/operations")).rejects.toThrow("stale_instance");
    expect(transport.resourceUrl("/plugins/objectives/evidence/read?id=one")).toContain(`instanceId=${INSTANCE_A}`);
    abort.abort();
    await expect(transport.request("/api/v1/operations")).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("relays the product upload limit as bytes and cancels a late file read before dispatch", async () => {
    const abort = new AbortController();
    let expectedBytes = 10 * 1024 * 1024;
    const request = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ expectedInstanceId: INSTANCE_A, expectedEpoch: 7, path: "/api/v1/agent/attachments" });
      expect(Buffer.from(body.dataBase64, "base64")).toHaveLength(expectedBytes);
      expect(body).not.toHaveProperty("headers");
      return Response.json({ requestId: body.requestId, epoch: 7, instanceId: INSTANCE_A, status: 200, contentType: "application/json", json: { id: "upload-id" } });
    });
    const transport = createRemoteHostTransport({ hostKey: "remote", epoch: 7, instanceId: INSTANCE_A, signal: abort.signal }, {
      fetch: request, events: () => { throw new Error("unexpected_events"); }, socket: () => { throw new Error("unexpected_socket"); }, origin: "http://127.0.0.1:1234",
    });
    const file = new Blob([new Uint8Array(10 * 1024 * 1024)], { type: "image/png" });
    const response = await transport.request("/api/v1/agent/attachments", { method: "POST", headers: { "Content-Type": file.type }, body: file });
    expect(await response.json()).toEqual({ id: "upload-id" });
    expect(request.mock.calls[0]?.[0]).toBe("/api/v1/hosts/remote/bytes");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=", "base64");
    expectedBytes = png.length;
    const unlabelled = new Blob([png]);
    const unlabelledResponse = await transport.request("/api/v1/agent/attachments", { method: "POST", headers: { "Content-Type": unlabelled.type || "application/octet-stream" }, body: unlabelled });
    expect(await unlabelledResponse.json()).toEqual({ id: "upload-id" });
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body)).dataBase64).toBe(png.toString("base64"));
    let finish!: (bytes: ArrayBuffer) => void;
    const lateFile = new Blob([new Uint8Array(8)], { type: "image/png" });
    vi.spyOn(lateFile, "arrayBuffer").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = transport.request("/api/v1/agent/attachments", { method: "POST", headers: { "Content-Type": lateFile.type }, body: lateFile });
    abort.abort(); finish(new ArrayBuffer(8));
    await expect(pending).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not grant control during exploration or accept a late activation for another host", async () => {
    const local = runtime("local");
    const remote = runtime("remote");
    const workspace = createHostWorkspace(local.port);
    workspace.add(remote.port);
    workspace.select(selection("remote"));
    await Promise.resolve();
    expect(remote.port.activate).not.toHaveBeenCalled();
    expect(workspace.getSnapshot()).toMatchObject({ foreground: selection("remote"), canWrite: false });
    let release: () => void = () => undefined;
    vi.mocked(remote.port.activate).mockImplementation(() => new Promise<void>((resolve) => { release = () => { remote.update({ mode: "controller" }); resolve(); }; }));
    const pending = workspace.activateConversation(selection("remote"));
    await Promise.resolve();
    await workspace.activateConversation(selection("local"));
    release();
    await pending;
    expect(workspace.getSnapshot()).toMatchObject({ foreground: selection("local"), canWrite: true });
    local.update({ epoch: 2, phase: "loading" });
    expect(workspace.getSnapshot()).toMatchObject({ foreground: null, canWrite: false });
    local.update({ phase: "ready" });
    expect(workspace.getSnapshot()).toMatchObject({ foreground: selection("local"), canWrite: false });
    workspace.dispose();
  });

  it("restores same-epoch local authority after hydration and reconnect without reactivating a remote", async () => {
    const local = runtime("local");
    local.update({ mode: "controller", connection: "connecting", phase: "loading" });
    const remote = runtime("remote");
    const workspace = createHostWorkspace(local.port);
    workspace.add(remote.port);
    workspace.syncLocalSelection(selection("local"));
    expect(workspace.getSnapshot().canWrite).toBe(false);
    local.update({ connection: "ready", phase: "ready" });
    expect(workspace.getSnapshot()).toMatchObject({ foreground: selection("local"), canWrite: true });
    local.update({ connection: "connecting", phase: "loading" });
    expect(workspace.getSnapshot().canWrite).toBe(false);
    local.update({ connection: "ready", phase: "ready" });
    expect(workspace.getSnapshot().canWrite).toBe(true);
    local.update({ mode: "observer" });
    expect(workspace.getSnapshot().canWrite).toBe(false);
    local.update({ mode: "controller" });
    expect(workspace.getSnapshot().canWrite).toBe(true);
    expect(local.port.activate).not.toHaveBeenCalled();
    await workspace.activateConversation(selection("remote"));
    expect(workspace.getSnapshot().canWrite).toBe(true);
    remote.update({ connection: "connecting", phase: "loading" });
    remote.update({ connection: "ready", phase: "ready" });
    expect(workspace.getSnapshot()).toMatchObject({ foreground: selection("remote"), canWrite: false });
    workspace.dispose();
  });

  it("allows monitoring snapshots without writing and preserves remote failure on local return", async () => {
    const remote = runtime("remote", "monitoring");
    const workspace = createHostWorkspace(runtime("local").port);
    workspace.add(remote.port);
    await workspace.activateConversation(selection("remote"));
    expect(remote.port.activate).not.toHaveBeenCalled();
    expect(workspace.getSnapshot()).toMatchObject({ foreground: selection("remote"), canWrite: false });
    remote.update({ connection: "blocked", phase: "error", trust: "mismatch", error: "remote_host_fingerprint_mismatch" });
    expect(workspace.getSnapshot().foreground).toBeNull();
    workspace.returnLocal();
    await Promise.resolve();
    expect(workspace.getSnapshot().selection.hostKey).toBe("local");
    expect(workspace.getSnapshot().hosts.find((host) => host.hostKey === "remote")).toMatchObject({ connection: "blocked", trust: "mismatch" });
    workspace.dispose();
  });
});

describe("remote host store", () => {
  it("remembers where to go and what to trust, and never the credential", () => {
    const harness = createHarness();
    const store = harness.open();

    const host = store.remember(link());

    expect(host).toMatchObject({ label: "devbox", origin: "https://100.84.12.7:6768", hostname: "100.84.12.7", port: 6768, fingerprint: FINGERPRINT_A, lastOpenedAt: null });
    expect(harness.stored()).not.toContain(TOKEN_A);
    expect(harness.stored()).toContain(FINGERPRINT_A);
  });

  it("hands the pending grant over exactly once", () => {
    const harness = createHarness();
    const store = harness.open();
    store.remember(link());

    const first = store.takeHandoff("https://100.84.12.7:6768");
    const second = store.takeHandoff("https://100.84.12.7:6768");

    expect(first?.token).toBe(TOKEN_A);
    expect(second?.token).toBeNull();
    // 두 번째도 호스트 자체는 여전히 열 수 있다 — 그때는 세션 쿠키가 통행증이다.
    expect(second?.host.origin).toBe("https://100.84.12.7:6768");
  });

  it("drops entries that lost their shape instead of trusting them", () => {
    const harness = createHarness();
    harness.files.set("/console/remote/known-hosts.json", JSON.stringify({
      version: 1,
      hosts: [
        { id: "keep", label: "ok", origin: "https://a.test:4310", hostname: "a.test", port: 4310, fingerprint: FINGERPRINT_A, addedAt: 1, lastOpenedAt: null },
        { id: "plaintext", label: "no", origin: "http://a.test:4310", hostname: "a.test", port: 4310, fingerprint: FINGERPRINT_A, addedAt: 1, lastOpenedAt: null },
        { id: "no-pin", label: "no", origin: "https://b.test:4310", hostname: "b.test", port: 4310, fingerprint: "short", addedAt: 1, lastOpenedAt: null },
      ],
    }));

    expect(harness.open().list().map((entry) => entry.id)).toEqual(["keep"]);
  });
});
