import type { LoginStart, LoginStatus } from "@fleet-console/ai-gateway";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

/** 로그인이 멈춘 이유. 「취소」는 실패가 아니라 처음 카드로 돌아가는 것이라 여기에 없다. */
export type MuseLoginFailure = "denied" | "expired" | "failed" | "entitlement_required";

/**
 * Muse Code 로그인 카드의 클라이언트 상태. 진행 중 코드·링크는 DTO가 아니라 여기에만 있다.
 * device code 폴링은 서버가 하고, 이 상태는 서버의 로그인 상태를 읽어 옮길 뿐이다.
 */
export type MuseLoginState =
  | { readonly phase: "idle" }
  | { readonly phase: "starting" }
  | {
    readonly phase: "pending";
    readonly loginId: string;
    readonly userCode: string;
    readonly url: string;
    readonly expiresAt: number;
  }
  | { readonly phase: "failed"; readonly reason: MuseLoginFailure; readonly actionUrl?: string }
  | { readonly phase: "signed_in" };

const STATUS_POLL_MS = 2_000;
const IDLE: MuseLoginState = { phase: "idle" };

/* 팝업은 닫히면 언마운트된다 — 승인하러 브라우저에 다녀온 사이 코드가 사라지지 않도록 상태는 번들에 둔다.
   폴링은 코드의 유효 시간이 끝나면 멈추므로 화면이 없어도 무한히 돌지 않는다. */
let state: MuseLoginState = IDLE;
let generation = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function setState(next: MuseLoginState): void {
  state = next;
  for (const listener of listeners) listener();
}

function stopPolling(): void {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
}

export function subscribeMuseLogin(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getMuseLoginState(): MuseLoginState {
  return state;
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

function schedulePoll(api: ClientApiCapability, captured: number): void {
  stopPolling();
  pollTimer = setTimeout(() => { void poll(api, captured); }, STATUS_POLL_MS);
}

async function poll(api: ClientApiCapability, captured: number): Promise<void> {
  pollTimer = undefined;
  const current = state;
  if (captured !== generation || current.phase !== "pending") return;
  let status: LoginStatus | null = null;
  let missing = false;
  try {
    const response = await api.fetch("quota", `muse-code/status?loginId=${encodeURIComponent(current.loginId)}`);
    if (response.ok) status = await response.json() as LoginStatus;
    else missing = response.status === 404;
  } catch {
    // 일시적인 끊김은 다음 차례에 다시 읽는다.
  }
  if (captured !== generation) return;
  // 서버가 이 로그인을 모른다(Console 재시작 등) — 이어서 기다릴 대상이 없다.
  if (missing) { setState({ phase: "failed", reason: "failed" }); return; }
  if (status === null || status.state === "pending") {
    if (Date.now() >= current.expiresAt) { setState({ phase: "failed", reason: "expired" }); return; }
    schedulePoll(api, captured);
    return;
  }
  switch (status.state) {
    case "signed_in":
      setState({ phase: "signed_in" });
      return;
    case "cancelled":
      setState(IDLE);
      return;
    case "entitlement_required": {
      const actionUrl = safeExternalUrl(status.actionUrl);
      setState({ phase: "failed", reason: "entitlement_required", ...(actionUrl ? { actionUrl } : {}) });
      return;
    }
    case "denied":
    case "expired":
      setState({ phase: "failed", reason: status.state });
      return;
    default:
      setState({ phase: "failed", reason: "failed" });
  }
}

/** 로그인을 시작한다. 서버에 이미 진행 중인 로그인이 있으면 같은 코드를 돌려받는다. */
export async function startMuseLogin(api: ClientApiCapability): Promise<void> {
  if (state.phase === "starting" || state.phase === "pending") return;
  stopPolling();
  const captured = ++generation;
  setState({ phase: "starting" });
  try {
    const response = await api.fetch("quota", "muse-code/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error("start_failed");
    const started = await response.json() as LoginStart;
    const url = safeExternalUrl(started.verificationUriComplete) ?? safeExternalUrl(started.verificationUri);
    if (captured !== generation) return;
    if (url === null || typeof started.loginId !== "string" || typeof started.userCode !== "string") throw new Error("invalid_start");
    setState({ phase: "pending", loginId: started.loginId, userCode: started.userCode, url, expiresAt: started.expiresAt });
    schedulePoll(api, captured);
  } catch {
    if (captured === generation) setState({ phase: "failed", reason: "failed" });
  }
}

/** 진행 중인 로그인을 그만두고 처음 카드로 돌아간다. */
export function cancelMuseLogin(api: ClientApiCapability): void {
  const current = state;
  stopPolling();
  generation += 1;
  setState(IDLE);
  if (current.phase !== "pending") return;
  void api.fetch("quota", "muse-code/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId: current.loginId }),
  }).catch(() => undefined);
}

/** 실패 안내나 완료 표시를 걷고 처음 카드로 돌아간다. */
export function resetMuseLogin(): void {
  if (state.phase === "idle") return;
  stopPolling();
  generation += 1;
  setState(IDLE);
}

/** 플러그인이 내려갈 때 폴링을 멈춘다. 서버의 로그인은 그대로 둔다(유효 시간이 지나면 서버가 정리한다). */
export function disposeMuseLogin(): void {
  stopPolling();
  generation += 1;
  state = IDLE;
}
