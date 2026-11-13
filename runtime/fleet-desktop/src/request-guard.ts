/**
 * 창이 보내는 요청에서 형제 포트의 콘솔 쿠키를 뺀다.
 *
 * 쿠키는 포트로 갈리지 않아, 같은 호스트의 다른 콘솔이 페어링 값을 헤더로 보게 된다.
 * Electron은 `onBeforeSendHeaders` 리스너를 세션당 하나만 두므로, 이 필터가 그 자리의
 * 주인이고 다른 표시(브라우저 뷰 출처)는 더해지기만 한다. 리스너를 `null`로 지우면
 * 형제 쿠키가 다시 나간다 — 해제 경로는 extra만 내리고 이 필터는 남긴다.
 * 헤더를 고치다 실패하면 요청을 보내지 않는다.
 */

/** 뷰 출처 표식은 집 콘솔(http 루프백)의 SSE에도 붙어야 하므로 http·ws를 빼지 않는다. */
const FILTER = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] };

type HeaderMap = Record<string, string>;

export interface RequestGuardDetails {
  readonly url: string;
  readonly requestHeaders: HeaderMap;
  readonly webContentsId?: number;
}

export type RequestGuardExtra = (details: RequestGuardDetails, headers: HeaderMap) => void;

export interface GuardedSession {
  webRequest: {
    onBeforeSendHeaders(
      filter: { readonly urls: readonly string[] },
      listener: (details: RequestGuardDetails, callback: (response: { requestHeaders?: HeaderMap; cancel?: boolean }) => void) => void,
    ): void;
  };
}

interface GuardState {
  extra: RequestGuardExtra | null;
}

const guards = new WeakMap<object, GuardState>();

/** 세션에 쿠키 필터를 한 번만 단다. 이미 있으면 그대로 둔다. */
export function installRequestGuard(session: GuardedSession): void {
  if (guards.has(session)) return;
  const state: GuardState = { extra: null };
  guards.set(session, state);
  session.webRequest.onBeforeSendHeaders(FILTER, (details, callback) => {
    try {
      const headers: HeaderMap = { ...details.requestHeaders };
      stripSiblingFleetCookies(headers, details.url);
      state.extra?.(details, headers);
      callback({ requestHeaders: headers });
    } catch {
      callback({ cancel: true });
    }
  });
}

/** 같은 리스너 위에 표시를 올리거나 내린다. 쿠키 필터는 내리지 않는다. */
export function setRequestGuardExtra(session: GuardedSession, extra: RequestGuardExtra | null): void {
  installRequestGuard(session);
  const state = guards.get(session);
  if (state) state.extra = extra;
}

function stripSiblingFleetCookies(headers: HeaderMap, rawUrl: string): void {
  const url = new URL(rawUrl);
  const port = url.port === "" ? (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80") : url.port;
  const keys = Object.keys(headers).filter((name) => name.toLowerCase() === "cookie");
  if (keys.length === 0) return;
  const primary = keys[0];
  if (primary === undefined) return;
  const kept = keys.flatMap((key) => headers[key]?.split(";") ?? []).map((part) => part.trim()).filter(Boolean).filter((part) => {
    const separator = part.indexOf("=");
    const name = (separator === -1 ? part : part.slice(0, separator)).trim();
    // 서버가 심는 이름은 이 둘뿐이다(auth.ts). 다른 사이트의 fleet_* 쿠키는 건드리지 않는다.
    const match = /^fleet_console_(?:session|pairing)_(\d+)$/u.exec(name);
    return match === null || match[1] === port;
  });
  for (const key of keys) if (key !== primary) delete headers[key];
  if (kept.length === 0) delete headers[primary];
  else headers[primary] = kept.join("; ");
}
