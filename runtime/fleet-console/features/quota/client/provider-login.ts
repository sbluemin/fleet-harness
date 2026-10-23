import type { LoginStart, LoginStatus } from "@fleet-console/ai-gateway";
import type { ClientApiCapability } from "@fleet-console/infra/http/client-ports";

import { LOGIN_PROVIDERS, type LoginProvider } from "../shared/provider-order.js";

/** 로그인이 멈춘 이유. 「취소」는 실패가 아니라 처음 카드로 돌아가는 것이라 여기에 없다. */
export type LoginFailure = "denied" | "expired" | "failed" | "entitlement_required";

/**
 * 공급자 로그인 카드의 클라이언트 상태. 진행 중 코드·링크는 DTO가 아니라 여기에만 있다.
 * 폴링은 서버가 하고, 이 상태는 서버의 로그인 상태를 읽어 옮길 뿐이다.
 */
export type LoginState =
  | { readonly phase: "idle" }
  | { readonly phase: "starting" }
  | {
    readonly phase: "pending";
    readonly loginId: string;
    /** 입력하거나 확인할 코드. 코드가 없는 흐름(Cursor)은 빈 문자열이다. */
    readonly userCode: string;
    /** 링크에 코드가 이미 실려 있으면 확인만, 아니면 페이지에서 입력한다. */
    readonly codeInUrl: boolean;
    readonly url: string;
    readonly expiresAt: number;
  }
  | { readonly phase: "failed"; readonly reason: LoginFailure; readonly actionUrl?: string }
  | { readonly phase: "signed_in" };

export type LoginStates = Readonly<Record<LoginProvider, LoginState>>;

const STATUS_POLL_MS = 2_000;
const IDLE: LoginState = { phase: "idle" };

function idleStates(): LoginStates {
  return Object.fromEntries(LOGIN_PROVIDERS.map((provider) => [provider, IDLE])) as LoginStates;
}

/* 팝업은 닫히면 언마운트된다 — 승인하러 브라우저에 다녀온 사이 코드가 사라지지 않도록 상태는 번들에 둔다.
   폴링은 코드의 유효 시간이 끝나면 멈추므로 화면이 없어도 무한히 돌지 않는다. 공급자마다 독립이다. */
let states: LoginStates = idleStates();
const generations = new Map<LoginProvider, number>();
const pollTimers = new Map<LoginProvider, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function setState(provider: LoginProvider, next: LoginState): void {
  states = { ...states, [provider]: next };
  for (const listener of listeners) listener();
}

function generation(provider: LoginProvider): number {
  return generations.get(provider) ?? 0;
}

function bump(provider: LoginProvider): number {
  const next = generation(provider) + 1;
  generations.set(provider, next);
  return next;
}

function stopPolling(provider: LoginProvider): void {
  const timer = pollTimers.get(provider);
  if (timer !== undefined) clearTimeout(timer);
  pollTimers.delete(provider);
}

export function subscribeLogins(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 공급자별 상태의 스냅숏. 바뀔 때만 새 객체다(useStoreSnapshot). */
export function getLoginStates(): LoginStates {
  return states;
}

/** 공급자가 준 링크는 https일 때만 연다(그 외 스킴은 열지 않는다). */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** 새 탭(브라우저) 또는 시스템 브라우저(Desktop)로 연다. */
export function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

function schedulePoll(api: ClientApiCapability, provider: LoginProvider, captured: number): void {
  stopPolling(provider);
  pollTimers.set(provider, setTimeout(() => { void poll(api, provider, captured); }, STATUS_POLL_MS));
}

async function poll(api: ClientApiCapability, provider: LoginProvider, captured: number): Promise<void> {
  pollTimers.delete(provider);
  const current = states[provider];
  if (captured !== generation(provider) || current.phase !== "pending") return;
  let status: LoginStatus | null = null;
  let missing = false;
  try {
    const response = await api.fetch(`quota/${provider}/status?loginId=${encodeURIComponent(current.loginId)}`);
    if (response.ok) status = await response.json() as LoginStatus;
    else missing = response.status === 404;
  } catch {
    // 일시적인 끊김은 다음 차례에 다시 읽는다.
  }
  if (captured !== generation(provider)) return;
  // 서버가 이 로그인을 모른다(Console 재시작 등) — 이어서 기다릴 대상이 없다.
  if (missing) { setState(provider, { phase: "failed", reason: "failed" }); return; }
  if (status === null || status.state === "pending") {
    if (Date.now() >= current.expiresAt) { setState(provider, { phase: "failed", reason: "expired" }); return; }
    schedulePoll(api, provider, captured);
    return;
  }
  switch (status.state) {
    case "signed_in":
      setState(provider, { phase: "signed_in" });
      return;
    case "cancelled":
      setState(provider, IDLE);
      return;
    case "entitlement_required": {
      const actionUrl = safeExternalUrl(status.actionUrl);
      setState(provider, { phase: "failed", reason: "entitlement_required", ...(actionUrl ? { actionUrl } : {}) });
      return;
    }
    case "denied":
    case "expired":
      setState(provider, { phase: "failed", reason: status.state });
      return;
    default:
      setState(provider, { phase: "failed", reason: "failed" });
  }
}

/** 로그인을 시작한다. 서버에 이미 진행 중인 로그인이 있으면 같은 코드를 돌려받는다. */
export async function startLogin(api: ClientApiCapability, provider: LoginProvider): Promise<void> {
  const current = states[provider];
  if (current.phase === "starting" || current.phase === "pending") return;
  stopPolling(provider);
  const captured = bump(provider);
  setState(provider, { phase: "starting" });
  try {
    const response = await api.fetch(`quota/${provider}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error("start_failed");
    const started = await response.json() as LoginStart;
    const complete = safeExternalUrl(started.verificationUriComplete);
    const url = complete ?? safeExternalUrl(started.verificationUri);
    if (captured !== generation(provider)) return;
    if (url === null || typeof started.loginId !== "string" || typeof started.userCode !== "string") throw new Error("invalid_start");
    setState(provider, {
      phase: "pending", loginId: started.loginId, userCode: started.userCode,
      codeInUrl: complete !== null, url, expiresAt: started.expiresAt,
    });
    schedulePoll(api, provider, captured);
  } catch {
    if (captured === generation(provider)) setState(provider, { phase: "failed", reason: "failed" });
  }
}

/** 진행 중인 로그인을 그만두고 처음 카드로 돌아간다. */
export function cancelLogin(api: ClientApiCapability, provider: LoginProvider): void {
  const current = states[provider];
  stopPolling(provider);
  bump(provider);
  setState(provider, IDLE);
  if (current.phase !== "pending") return;
  void api.fetch(`quota/${provider}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId: current.loginId }),
  }).catch(() => undefined);
}

/** 실패 안내나 완료 표시를 걷고 처음 카드로 돌아간다. */
export function resetLogin(provider: LoginProvider): void {
  if (states[provider].phase === "idle") return;
  stopPolling(provider);
  bump(provider);
  setState(provider, IDLE);
}

/** 플러그인이 내려갈 때 폴링을 멈춘다. 서버의 로그인은 그대로 둔다(유효 시간이 지나면 서버가 정리한다). */
export function disposeLogins(): void {
  for (const provider of LOGIN_PROVIDERS) {
    stopPolling(provider);
    bump(provider);
  }
  states = idleStates();
}
