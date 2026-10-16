import type { HostScope, HostTransport } from "./types.js";

export function assertHostScope(scope: HostScope): void {
  scope.signal.throwIfAborted();
}

/** 본문 파싱도 비동기 경계다. 전송 완료 뒤 scope가 폐기된 결과를 저장하지 않는다. */
export async function readHostJson<T>(scope: HostScope, response: Response): Promise<T> {
  const value: unknown = await response.json();
  assertHostScope(scope);
  return value as T;
}

export function hostStorageKey(hostKey: string, key: string): string {
  return `host:${encodeURIComponent(hostKey)}:${key}`;
}

/** URL을 받아 origin을 바꾸는 능력이 아니다. 서버의 route/containment 검사도 별도로 유지한다. */
export function assertHostPath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n\u0000#]/u.test(path)) throw new Error("invalid_host_path");
}

export interface LocalHostTransportDependencies {
  readonly scope: HostScope;
  readonly fetch: typeof fetch;
  readonly events: (path: string) => EventSource;
  readonly socket: (url: string) => WebSocket;
  readonly origin: string;
}

/** 로컬 전송은 별도의 인스턴스다. 선택한 원격의 실패를 이 경로로 우회하지 않는다. */
export function createLocalHostTransport(deps: LocalHostTransportDependencies): HostTransport {
  const scope = Object.freeze({ ...deps.scope });
  if (scope.hostKey !== "local") throw new Error("local_host_required");
  const check = (path: string) => { assertHostScope(scope); assertHostPath(path); };
  return Object.freeze<HostTransport>({
    scope: scope,
    request: async (path: string, init?: RequestInit) => {
      check(path);
      const signal = init?.signal ? AbortSignal.any([scope.signal, init.signal]) : scope.signal;
      const response = await deps.fetch(path, { ...init, signal });
      assertHostScope(scope);
      return response;
    },
    events: (path: string) => {
      check(path);
      const source = deps.events(path);
      const close = () => { source.close(); scope.signal.removeEventListener("abort", close); };
      scope.signal.addEventListener("abort", close, { once: true });
      return {
        get readyState() { return source.readyState; },
        get onopen() { return source.onopen; }, set onopen(value) { source.onopen = value; },
        get onmessage() { return source.onmessage; }, set onmessage(value) { source.onmessage = value; },
        get onerror() { return source.onerror; }, set onerror(value) { source.onerror = value; },
        addEventListener: source.addEventListener.bind(source),
        removeEventListener: source.removeEventListener.bind(source),
        close,
      };
    },
    socket: (path, target) => {
      check(path);
      if (!target.ticket) throw new Error("terminal_ticket_required");
      const url = new URL(path, deps.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", target.ticket);
      const socket = deps.socket(url.toString());
      const close = () => socket.close();
      scope.signal.addEventListener("abort", close, { once: true });
      socket.addEventListener("close", () => scope.signal.removeEventListener("abort", close), { once: true });
      return socket;
    },
    resourceUrl: (path: string) => { check(path); return path; },
  });
}

/** 구버전 로컬 소비자의 기본값. 원격을 선택하는 composition은 반드시 실제 transport를 주입한다. */
export function createBrowserLocalTransport(): HostTransport {
  const scope = Object.freeze({ hostKey: "local", epoch: 0, signal: new AbortController().signal });
  return createLocalHostTransport({ scope, fetch: (...args) => fetch(...args), events: (path) => new EventSource(path), socket: (url) => new WebSocket(url), origin: typeof location === "undefined" ? "http://localhost" : location.origin });
}
