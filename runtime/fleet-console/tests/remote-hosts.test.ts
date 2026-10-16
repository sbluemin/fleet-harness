import { describe, expect, it, vi } from "vitest";
import type { HostSelection, HostView } from "@fleet-console/sdk/host-context";
import { createHostWorkspace, type HostRuntimePort } from "../core/client/src/integration/host-workspace.js";
import { createRemoteHostTransport } from "../core/client/src/integration/remote-host-transport.js";
import { createRemoteHostRuntime } from "../core/client/src/integration/remote-host-runtime.js";
import type { HostEventSource } from "@fleet-console/sdk/host-context";

import { encodeAccessLink, parseAccessLink, type ValidatedAccessLink } from "../features/remote-access/host/access-link.js";
import { createRemoteHostStore, type RemoteHostStoreDeps } from "../features/remote-access/host/remote-hosts.js";

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
  it("keeps background hosts stream-free and closes both viewer streams before parking", async () => {
    const sources: Array<{ close: ReturnType<typeof vi.fn>; listeners: Map<string, (event: { data: string }) => void> }> = [];
    const request = vi.fn(async (path: string) => new Response(JSON.stringify(path === "/api/v1/theaters" ? { theaters: [{ id: "same-theater", label: "remote" }] } : path === "/api/v1/operations" ? { operations: [{ id: "same-operation", theaterId: "same-theater", title: "remote", type: "agent" }] } : { sessions: [] })));
    const remote = createRemoteHostRuntime({
      hostKey: "remote", label: "remote",
      readPresence: async () => ({ hostKey: "remote", epoch: 1, mode: "observer", access: "monitoring", connection: "ready" }),
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

  it("binds HTTP and resource requests to the expected host epoch without credential or local fallback", async () => {
    const abort = new AbortController();
    let responseEpoch = 7;
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)) as { requestId: string };
      return new Response(JSON.stringify({ requestId: input.requestId, epoch: responseEpoch, status: 403, contentType: "application/json", json: { error: "read_only" } }), { headers: { "Content-Type": "application/json" } });
    });
    const transport = createRemoteHostTransport({ hostKey: "remote", epoch: 7, signal: abort.signal }, {
      fetch: request,
      events: () => { throw new Error("unexpected_event_source"); },
      socket: () => { throw new Error("unexpected_socket"); },
      origin: "http://127.0.0.1:1234",
    });
    const response = await transport.request("/api/v1/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId: "same-theater" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "read_only" });
    expect(request.mock.calls[0]?.[0]).toBe("/api/v1/hosts/remote/request");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ expectedEpoch: 7, method: "POST", path: "/api/v1/operations", json: { theaterId: "same-theater" } });
    expect(transport.resourceUrl("/plugins/objectives/evidence/read?id=one")).toContain("epoch=7");
    await expect(transport.request("https://other.example/api/v1/operations")).rejects.toThrow("invalid_host_request");
    await expect(transport.request("/api/v1/operations", { headers: { Authorization: "secret" } })).rejects.toThrow("invalid_host_request");
    expect(request).toHaveBeenCalledTimes(1);
    responseEpoch = 8;
    await expect(transport.request("/api/v1/operations")).rejects.toThrow("stale_epoch");
    expect(request).toHaveBeenCalledTimes(2);
    abort.abort();
    await expect(transport.request("/api/v1/operations")).rejects.toThrow();
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
