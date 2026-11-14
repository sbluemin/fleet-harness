/**
 * 창이 주고받는 콘솔 쿠키에서 형제 포트 이름을 뺀다.
 *
 * 쿠키는 포트로 갈리지 않는다. 요청의 Cookie에서는 형제 콘솔이 페어링 값을 보지 못하게 하고,
 * 응답의 Set-Cookie에서는 형제 콘솔이 우리 포트의 세션·페어링 쿠키를 덮어쓰거나(Max-Age=0 포함)
 * 지우지 못하게 한다. 이름 포트가 같아도 Domain 속성이 있으면 뺀다. 서버는 Domain을 내지 않는다(auth.ts).
 * 거르는 이름은 서버가 심는 둘뿐이다.
 *
 * Electron은 `onBeforeSendHeaders`와 `onHeadersReceived`를 세션·이벤트당 하나씩만 둔다.
 * 두 리스너는 installRequestGuard에서만 함께 단다. onHeadersReceived의 다른 호출처는 없다.
 * 이 모듈이 그 두 자리의 주인이고, 브라우저 뷰 출처 표시는 요청 리스너 위에만 더해진다.
 * 리스너를 `null`로 바꾸면 형제 쿠키가 다시 드나든다 — 해제 경로는 extra만 내리고 두 필터는 남긴다.
 * 헤더를 고치다 실패하면 요청은 보내지 않고 응답은 통과시키지 않는다.
 */

/** 뷰 출처 표식은 집 콘솔(http 루프백)의 SSE에도 붙어야 하므로 http·ws를 빼지 않는다. */
const FILTER = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] };

/** 페이지에 보여주는 식별과 같은 규칙. Electron·셸 표기만 빼고, 나머지 User-Agent는 그대로 둔다. */
export function browserDocumentUserAgent(raw: string): string {
  return raw.replace(/ (?:Electron|FleetConsole\w*|fleet-console\w*)\/\S+/gu, "");
}

const FLEET_CONSOLE_COOKIE = /^fleet_console_(?:session|pairing)_(\d+)$/u;

type HeaderMap = Record<string, string>;
type ResponseHeaderMap = Record<string, string | readonly string[]>;

export interface RequestGuardDetails {
  readonly url: string;
  readonly requestHeaders: HeaderMap;
  readonly webContentsId?: number;
}

export interface ResponseGuardDetails {
  readonly url: string;
  readonly responseHeaders?: ResponseHeaderMap;
}

export type RequestGuardExtra = (details: RequestGuardDetails, headers: HeaderMap) => void;

export interface GuardedSession {
  webRequest: {
    onBeforeSendHeaders(
      filter: { readonly urls: readonly string[] },
      listener: (details: RequestGuardDetails, callback: (response: { requestHeaders?: HeaderMap; cancel?: boolean }) => void) => void,
    ): void;
    onHeadersReceived(
      filter: { readonly urls: readonly string[] },
      listener: (details: ResponseGuardDetails, callback: (response: { responseHeaders?: Record<string, string | string[]>; cancel?: boolean }) => void) => void,
    ): void;
  };
}

interface GuardState {
  extra: RequestGuardExtra | null;
  /** 브라우저 세션만. 요청에 이미 있는 User-Agent에서 셸 표기를 뺀다. */
  stripShellUserAgent: boolean;
}

const guards = new WeakMap<object, GuardState>();

/** 세션에 요청·응답 쿠키 필터를 한 번만 단다. 이미 있으면 그대로 둔다. */
export function installRequestGuard(session: GuardedSession): void {
  if (guards.has(session)) return;
  attach(session, { extra: null, stripShellUserAgent: false });
}

/** 같은 요청 리스너 위에 표시를 올리거나 내린다. 쿠키 필터는 내리지 않는다. */
export function setRequestGuardExtra(session: GuardedSession, extra: RequestGuardExtra | null): void {
  const state = guards.get(session);
  if (state) {
    state.extra = extra;
    return;
  }
  // 표시가 든 state를 리스너보다 먼저 만들어 넘긴다. 등록 직후 도착한 요청도 그 표시를 본다.
  attach(session, { extra, stripShellUserAgent: false });
}

/**
 * 브라우저 세션에서만 켠다. 그 요청의 User-Agent에 있는 Electron·셸 표기를 뺀다.
 * 표기가 없으면 값은 그대로다. 콘솔 세션은 부르지 않는다.
 * Electron 43의 session.setUserAgent는 서비스 워커 fetch의 User-Agent를 바꾸지 못한다.
 */
export function setRequestGuardStripShellUserAgent(session: GuardedSession, enabled: boolean): void {
  const state = guards.get(session);
  if (state) {
    state.stripShellUserAgent = enabled;
    return;
  }
  attach(session, { extra: null, stripShellUserAgent: enabled });
}

function attach(session: GuardedSession, state: GuardState): void {
  // state는 호출자가 먼저 만든다. 리스너가 그것을 닫아 잡으므로, 등록 직후 요청도 이미 넣은 표시를 본다.
  // 두 등록이 모두 끝난 뒤에야 설치로 기록한다. 두 번째가 던지면 반쪽인 채 남기지 않고 다음 설치가 다시 단다.
  session.webRequest.onBeforeSendHeaders(FILTER, (details, callback) => {
    let response: { requestHeaders?: HeaderMap; cancel?: boolean };
    try {
      const headers: HeaderMap = { ...details.requestHeaders };
      stripSiblingFleetCookies(headers, details.url);
      state.extra?.(details, headers);
      if (state.stripShellUserAgent) stripShellUserAgent(headers);
      response = { requestHeaders: headers };
    } catch {
      response = { cancel: true };
    }
    callback(response);
  });
  session.webRequest.onHeadersReceived(FILTER, (details, callback) => {
    // 예외를 삼키고 원본을 넘기면 형제 Set-Cookie가 통과한다. 요청 가드와 같이 응답을 끊는다.
    // 조인 응답까지 잃을 수 있지만, 쿠키를 덮어쓰게 두는 쪽보다 닫힌 쪽이다. callback은 한 번만.
    let response: { responseHeaders?: Record<string, string | string[]>; cancel?: boolean };
    try {
      if (details.responseHeaders === undefined) response = {};
      else {
        const headers = withoutSiblingSetCookies(details.responseHeaders, endpointPort(details.url));
        // 뺀 줄이 없으면 헤더를 다시 만들지 않는다. 순서를 바꾸거나 statusLine을 비우지 않기 위해서다.
        response = headers === null ? {} : { responseHeaders: headers };
      }
    } catch {
      response = { cancel: true };
    }
    callback(response);
  });
  guards.set(session, state);
}

function stripShellUserAgent(headers: HeaderMap): void {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== "user-agent") continue;
    const value = headers[name];
    if (value === undefined) continue;
    headers[name] = browserDocumentUserAgent(value);
  }
}

function endpointPort(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.port !== "") return url.port;
  return url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80";
}

function fleetConsoleCookiePort(name: string): string | null {
  return FLEET_CONSOLE_COOKIE.exec(name)?.[1] ?? null;
}

function stripSiblingFleetCookies(headers: HeaderMap, rawUrl: string): void {
  const port = endpointPort(rawUrl);
  const keys = Object.keys(headers).filter((name) => name.toLowerCase() === "cookie");
  if (keys.length === 0) return;
  const primary = keys[0];
  if (primary === undefined) return;
  const kept = keys.flatMap((key) => headers[key]?.split(";") ?? []).map((part) => part.trim()).filter(Boolean).filter((part) => {
    const separator = part.indexOf("=");
    const name = (separator === -1 ? part : part.slice(0, separator)).trim();
    const cookiePort = fleetConsoleCookiePort(name);
    return cookiePort === null || cookiePort === port;
  });
  for (const key of keys) if (key !== primary) delete headers[key];
  if (kept.length === 0) delete headers[primary];
  else headers[primary] = kept.join("; ");
}

function headerLines(value: string | readonly string[]): readonly string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) throw new Error("response header is not text");
  const lines: string[] = [];
  for (const line of value) {
    if (typeof line !== "string") throw new Error("response header is not text");
    lines.push(line);
  }
  return lines;
}

function setCookieHasDomain(line: string): boolean {
  const attributes = line.split(";").slice(1);
  return attributes.some((part) => {
    const separator = part.indexOf("=");
    const name = (separator === -1 ? part : part.slice(0, separator)).trim();
    return name.toLowerCase() === "domain";
  });
}

/**
 * 콘솔 이름 Set-Cookie를 뺀 헤더. 뺀 줄이 없으면 null.
 * 요소 하나가 쿠키 하나다. `,`나 `;`로 쿠키를 나누지 않고, 이름은 첫 `=` 앞을 trim 한 것이다.
 * 이름 포트가 응답 포트와 다르거나 Domain 속성이 있으면 뺀다. 글을 읽을 수 없는 요소는 넘기지 않고 예외로 올린다.
 */
function withoutSiblingSetCookies(source: ResponseHeaderMap, port: string): Record<string, string | string[]> | null {
  let changed = false;
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key.toLowerCase() !== "set-cookie") {
      headers[key] = typeof value === "string" ? value : [...headerLines(value)];
      continue;
    }
    const lines = headerLines(value);
    const kept = lines.filter((line) => {
      const separator = line.indexOf("=");
      const name = (separator === -1 ? line : line.slice(0, separator)).trim();
      const cookiePort = fleetConsoleCookiePort(name);
      if (cookiePort === null) return true;
      return cookiePort === port && !setCookieHasDomain(line);
    });
    if (kept.length !== lines.length) changed = true;
    if (kept.length === 0) continue;
    const only = kept[0];
    headers[key] = typeof value === "string" && only !== undefined ? only : [...kept];
  }
  return changed ? headers : null;
}
