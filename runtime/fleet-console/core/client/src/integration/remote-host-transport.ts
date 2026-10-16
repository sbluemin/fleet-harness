import type { HostEventSource, HostScope, HostTransport } from "@fleet-console/sdk/host-context";
import { assertHostScope, readHostJson } from "@fleet-console/sdk/host-context/browser";
import {
  HOST_JSON_CONTENT_TYPE, HOST_UPLOAD_MAX_BYTES, isHostUploadRequest, hostEventsUrl, hostResourcesUrl, hostSocketUrl, hostTransportPath,
  isHostInstanceId, isHostJsonRequest, isHostJsonResult, isHostPresence, isHostPresenceRequest, isHostTerminalUpgradePath, isHostTransportErrorBody,
  type HostJsonRequest, type HostPresence, type HostRelayMethod,
} from "@fleet-console/protocol/remote/host-transport";
import type { RemoteHostRuntimeDependencies } from "./remote-host-runtime.js";

export interface HostBrowserNetwork {
  readonly fetch: typeof fetch;
  readonly events: (path: string) => EventSource;
  readonly socket: (url: string) => WebSocket;
  readonly origin: string;
  readonly background?: (work: () => Promise<void>, signal: AbortSignal) => Promise<void>;
}

export class HostTransportFailure extends Error {
  constructor(readonly status: number, code: string) { super(code); this.name = "HostTransportFailure"; }
}

function requiredPath(path: string | null): string {
  if (path === null) throw new HostTransportFailure(400, "invalid_host_request");
  return path;
}

async function assertRelayResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const body: unknown = await response.json().catch(() => null);
  throw new HostTransportFailure(response.status, isHostTransportErrorBody(body) ? body.error : "remote_host_unavailable");
}

/** 브라우저 생성자도 명시적 port다. 요청 대상은 공개 wire helper로만 만든다. */
export function createRemoteHostTransport(inputScope: HostScope, network: HostBrowserNetwork): HostTransport {
  const scope = Object.freeze({ ...inputScope });
  const instanceId = scope.instanceId;
  if (!isHostInstanceId(instanceId)) throw new HostTransportFailure(400, "invalid_host_request");
  const requestPath = requiredPath(hostTransportPath("request", scope.hostKey));
  return Object.freeze<HostTransport>({
    scope,
    request: async (path, init) => {
      assertHostScope(scope);
      const headers = new Headers(init?.headers);
      const blob = init?.body instanceof Blob ? init.body : null;
      const method = (init?.method ?? "GET").toUpperCase() as HostRelayMethod;
      // 일반 RequestInit을 상류 헤더로 전달하지 않는다. 기존 JSON 호출의 표현만 허용한다.
      for (const [key, value] of headers) {
        const contentType = value.toLowerCase().split(";")[0]?.trim();
        // Blob MIME은 파일 선택기의 힌트일 뿐 wire에 싣지 않는다. 실제 형식은 원격 첨부 handler가 바이트로 판정한다.
        if ((key === "content-type" && (blob !== null || contentType === HOST_JSON_CONTENT_TYPE)) || (key === "accept" && value === HOST_JSON_CONTENT_TYPE)) continue;
        throw new HostTransportFailure(400, "invalid_host_request");
      }
      if (init?.credentials || init?.redirect || init?.referrer || init?.referrerPolicy || init?.integrity || init?.mode) throw new HostTransportFailure(400, "invalid_host_request");
      if (init?.body !== undefined && init.body !== null && typeof init.body !== "string" && !blob) throw new HostTransportFailure(403, "route_denied");
      let json: unknown;
      if (typeof init?.body === "string") {
        try { json = JSON.parse(init.body); } catch { throw new HostTransportFailure(400, "invalid_host_request"); }
      }
      const requestId = crypto.randomUUID();
      const signal = init?.signal ? AbortSignal.any([scope.signal, init.signal]) : scope.signal;
      const coordinates = { requestId, expectedEpoch: scope.epoch, expectedInstanceId: instanceId, path };
      let request: unknown;
      if (blob) {
        if (method !== "POST" || blob.size === 0 || blob.size > HOST_UPLOAD_MAX_BYTES) throw new HostTransportFailure(400, "invalid_host_request");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        signal.throwIfAborted();
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
        request = { ...coordinates, dataBase64: btoa(binary) };
        if (!isHostUploadRequest(request)) throw new HostTransportFailure(400, "invalid_host_request");
      } else {
        request = { ...coordinates, method, ...(typeof init?.body === "string" ? { json } : {}) } satisfies HostJsonRequest;
        if (!isHostJsonRequest(request)) throw new HostTransportFailure(400, "invalid_host_request");
      }
      signal.throwIfAborted();
      const response = await network.fetch(blob ? requiredPath(hostTransportPath("bytes", scope.hostKey)) : requestPath, { method: "POST", headers: { "Content-Type": HOST_JSON_CONTENT_TYPE }, body: JSON.stringify(request), signal, redirect: "error" });
      await assertRelayResponse(response);
      const result: unknown = await readHostJson(scope, response);
      signal.throwIfAborted();
      if (!isHostJsonResult(result) || result.requestId !== requestId || result.status < 200) throw new HostTransportFailure(502, "invalid_host_response");
      if (result.instanceId !== instanceId) throw new HostTransportFailure(409, "stale_instance");
      if (result.epoch !== scope.epoch) throw new HostTransportFailure(409, "stale_epoch");
      const body = result.contentType === null || [204, 205, 304].includes(result.status) || method === "HEAD" ? null : JSON.stringify(result.json);
      return new Response(body, { status: result.status, ...(result.contentType ? { headers: { "Content-Type": result.contentType } } : {}) });
    },
    events: (path) => {
      assertHostScope(scope);
      const source = network.events(requiredPath(hostEventsUrl(scope.hostKey, { path, epoch: scope.epoch, instanceId })));
      return bindEvents(scope, source);
    },
    resourceUrl: (path) => {
      assertHostScope(scope);
      return requiredPath(hostResourcesUrl(scope.hostKey, { path, epoch: scope.epoch, instanceId }));
    },
    socket: (path, target) => {
      assertHostScope(scope);
      if (!isHostTerminalUpgradePath(path) || target.ticket !== undefined || target.role !== undefined) throw new HostTransportFailure(400, "invalid_host_request");
      const route = requiredPath(hostSocketUrl(scope.hostKey, { epoch: scope.epoch, instanceId, channel: target.channel, operationId: target.operationId }));
      const url = new URL(route, network.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = network.socket(url.toString());
      const close = () => socket.close();
      scope.signal.addEventListener("abort", close, { once: true });
      socket.addEventListener("close", () => scope.signal.removeEventListener("abort", close), { once: true });
      return socket;
    },
  });
}

/** presence만 현재 epoch를 알려 준다. unsupported를 full 권한으로 추정하지 않는다. */
export function createRemoteHostDependencies(hostKey: string, label: string, network: HostBrowserNetwork): RemoteHostRuntimeDependencies {
  const path = requiredPath(hostTransportPath("presence", hostKey));
  async function readPresence(signal: AbortSignal): Promise<HostPresence> {
    const response = await network.fetch(path, { signal, redirect: "error", cache: "no-store" });
    await assertRelayResponse(response);
    const body: unknown = await response.json();
    signal.throwIfAborted();
    if (!isHostPresence(body) || body.hostKey !== hostKey) throw new HostTransportFailure(502, "invalid_host_response");
    if (body.capability !== "supported") throw new HostTransportFailure(409, "host_unsupported");
    return body;
  }
  return {
    hostKey, label, readPresence,
    changePresence: async (intent, epoch, instanceId, signal) => {
      const request = { intent, expectedEpoch: epoch, expectedInstanceId: instanceId };
      if (!isHostPresenceRequest(request)) throw new HostTransportFailure(400, "invalid_host_request");
      const response = await network.fetch(path, { method: "POST", headers: { "Content-Type": HOST_JSON_CONTENT_TYPE }, body: JSON.stringify(request), signal, redirect: "error" });
      await assertRelayResponse(response);
      signal.throwIfAborted();
      return readPresence(signal);
    },
    watchPresence: (receive, failed) => {
      // origin당 HTTP/1.1 여섯 연결을 배경 EventSource가 독점하지 않는다. 연결을 유지한 채 상태만 읽는다.
      const abort = new AbortController();
      let delay = 15_000;
      let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        const work = async () => {
          if (abort.signal.aborted) return;
          const presence = await readPresence(AbortSignal.any([abort.signal, AbortSignal.timeout(8_000)]));
          if (!abort.signal.aborted) await receive(presence);
        };
        try {
          await (network.background ? network.background(work, abort.signal) : work());
          delay = 15_000;
        } catch (cause) {
          if (!abort.signal.aborted) failed(cause instanceof Error ? cause : new Error("remote_host_unavailable"));
          delay = Math.min(60_000, delay * 2);
        }
        if (!abort.signal.aborted) timer = setTimeout(() => { void poll(); }, delay);
      };
      timer = setTimeout(() => { void poll(); }, delay);
      return () => { abort.abort(); clearTimeout(timer); };
    },
    createTransport: (scope) => createRemoteHostTransport(scope, network),
  };
}

function bindEvents(scope: HostScope, source: EventSource): HostEventSource {
  const close = () => { source.close(); scope.signal.removeEventListener("abort", close); };
  scope.signal.addEventListener("abort", close, { once: true });
  return {
    get readyState() { return source.readyState; },
    get onopen() { return source.onopen; }, set onopen(value) { source.onopen = value; },
    get onmessage() { return source.onmessage; }, set onmessage(value) { source.onmessage = value; },
    get onerror() { return source.onerror; }, set onerror(value) { source.onerror = value; },
    addEventListener: source.addEventListener.bind(source), removeEventListener: source.removeEventListener.bind(source), close,
  };
}
