import { DESKTOP_WINDOW_COMMAND_PATH } from "@fleet-console/protocol/desktop";

import { fetchGroups, fetchOperations, fetchTheaterBootstrap } from "./api.js";

/**
 * 호스트 전환의 원격은 HTTP/1.1이라 한 origin에 연결이 여섯 개다. 새 연결은 왕복 세 번이다.
 * 렌더가 여는 나머지 조회가 목록보다 먼저 그 여섯을 채우면, ready를 가르는 목록이 줄 선 만큼
 * 옛 화면을 붙잡는 시간이 길어진다. 그래서 데스크톱 셸에서는 목록을 가르는 조회만 바로 나가고,
 * 나머지는 첫 목록을 칠한 뒤 `console-ready`를 보낸 다음에 연다.
 *
 * 브라우저(셸 아님)는 이 대기를 켜지 않는다. 집을 목록만 그리는 갈래도 켜지 않는다.
 */

const BOOT_CRITICAL_PATHS = new Set([
  "/api/v1/settings/global",
  "/api/v1/settings/fonts/migration",
  "/api/v1/theaters",
  "/api/v1/operations",
  "/api/v1/operations/groups",
  DESKTOP_WINDOW_COMMAND_PATH,
]);

export interface BootSnapshots {
  readonly theaters: ReturnType<typeof fetchTheaterBootstrap>;
  readonly operations: ReturnType<typeof fetchOperations>;
  readonly groups: Promise<Awaited<ReturnType<typeof fetchGroups>> | null>;
}

let snapshots: BootSnapshots | null = null;
let armed = false;
let laneOpen = false;
let openLane: () => void = () => {};
const lane = new Promise<void>((resolve) => {
  openLane = () => {
    if (laneOpen) return;
    laneOpen = true;
    resolve();
  };
});

let nativeFetch: typeof window.fetch | null = null;

/** 데스크톱 셸의 콘솔 갈래에서만 부른다. 켜기 전에는 조회를 미루지 않는다. */
export function armBootLane(): void {
  armed = true;
}

export function bootLanePending(): boolean {
  return armed && !laneOpen;
}

export function openBootLane(): void {
  openLane();
}

export function afterBootLane(): Promise<void> {
  return bootLanePending() ? lane : Promise.resolve();
}

/**
 * 설정·매니페스트·목록·ready는 기다리지 않는다. 그 외의 `fetch`는 차선이 열릴 때까지 큐에 둔다.
 * 이미 시작한 요청은 가로채지 못한다 — 목록 조회는 이 게이트를 건 직후, 허용 경로로 나간다.
 */
export function installBootFetchGate(): void {
  if (typeof window === "undefined" || nativeFetch) return;
  const native = window.fetch.bind(window);
  nativeFetch = native;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!bootLanePending() || isBootCritical(input)) return native(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const fail = () => reject(abortError(signal));
      const onAbort = () => fail();
      signal?.addEventListener("abort", onAbort, { once: true });
      void lane.then(() => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          fail();
          return;
        }
        resolve(native(input, init));
      });
    });
  }) as typeof window.fetch;
}

function abortError(signal: AbortSignal | undefined): DOMException {
  const reason = signal?.reason;
  return reason instanceof DOMException ? reason : new DOMException("The operation was aborted.", "AbortError");
}

function isBootCritical(input: RequestInfo | URL): boolean {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    return BOOT_CRITICAL_PATHS.has(new URL(raw, window.location.origin).pathname);
  } catch {
    return false;
  }
}

/** 콘솔 갈래에서 한 번. 설정·매니페스트와 함께 시작하고, 수화는 호출하는 쪽이 한다. */
export function startBootSnapshots(): BootSnapshots {
  if (snapshots) return snapshots;
  snapshots = {
    theaters: fetchTheaterBootstrap(),
    operations: fetchOperations(null),
    groups: fetchGroups(null).catch(() => null),
  };
  return snapshots;
}
