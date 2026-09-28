/**
 * 로컬 Console의 읽기 전용 broker와 Desktop이 주고받는 내부 계약(A′).
 *
 * broker는 원격 콘솔을 로컬 루프백의 epoch 리스너로 비춘다. Desktop은 창의 주인(owner lease)으로 등록하고,
 * 조인해 얻은 **그 포트의 세션 쿠키 하나**만 위임한다. 페어링은 넘기지 않는다. 모든 요청은 메인 루프백
 * 리스너에 lock token으로 간다 — 그 토큰은 이 Desktop임을 증명하지 않으며(같은 UID는 경계 밖),
 * broker가 owner 범위로 가린다.
 *
 * lease는 명시적인 heartbeat로만 이어진다. 상태 스트림이 끊기거나 lease를 잃으면 활성 epoch은 곧바로 끝난 것으로
 * 본다(fail closed). 스트림이 다시 붙기를 기다리며 옛 화면을 두지 않는다.
 */

import {
  DESKTOP_PROXY_DIRECT_FALLBACK_ERRORS,
  DESKTOP_PROXY_EPOCH_STATE_EVENT,
  DESKTOP_PROXY_EPOCHS_PATH,
  DESKTOP_PROXY_EVENTS_PATH,
  DESKTOP_PROXY_HEARTBEAT_MS,
  DESKTOP_PROXY_OWNERS_PATH,
  isDesktopProxyEpochStateEvent,
  isDesktopProxyId,
  type DesktopProxyTerminalReason,
} from "@fleet-console/protocol/desktop";

const OWNERS_PATH = DESKTOP_PROXY_OWNERS_PATH;
const EPOCHS_PATH = DESKTOP_PROXY_EPOCHS_PATH;
const EVENTS_PATH = DESKTOP_PROXY_EVENTS_PATH;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_EVENT_CHARS = 16_384;

export type EpochTerminalReason = DesktopProxyTerminalReason;

export interface ProxyEpoch {
  readonly epochId: string;
  readonly generation: number;
  /** `http://127.0.0.1:<port>` — 이 epoch만의 리스너. */
  readonly origin: string;
  readonly cookieName: string;
  /** 이 응답에만 한 번 실려 온다. 쿠키로 옮긴 뒤 곧바로 버린다. 로그에 남기지 않는다. */
  readonly capability: string;
}

export interface DelegationRequest {
  readonly switchGeneration: number;
  readonly hostId: string;
  readonly pinGeneration: number;
  readonly session: { readonly name: string; readonly value: string };
}

/** 위임의 결과. `direct`는 A′ 대상이 아니라는 판정이고, 그때는 같은 세션으로 직결(B1)한다. */
export type DelegationResult =
  | { readonly kind: "epoch"; readonly epoch: ProxyEpoch }
  | { readonly kind: "direct"; readonly reason: string };

export interface ProxyBrokerDeps {
  readonly localOrigin: () => string | null;
  readonly lockToken: () => string | null;
  readonly fetch?: typeof fetch;
  readonly randomId: () => string;
  /** broker가 그 epoch을 끝냈다 — 이유와 함께. */
  readonly onTerminal: (epochId: string, generation: number, reason: EpochTerminalReason) => void;
  /** owner가 사라졌다(스트림 단절, lease 만료). 그 owner의 모든 epoch은 끝난 것이다. */
  readonly onOwnerLost: (reason: string) => void;
  readonly log?: (message: string) => void;
}

export interface ProxyBroker {
  delegate(request: DelegationRequest): Promise<DelegationResult>;
  /** 최신 전환 세대를 알린다. 이보다 옛 세대의 위임은 broker가 거절한다. owner가 없으면 아무 일도 없다. */
  announceSwitch(generation: number): Promise<void>;
  discard(epoch: Pick<ProxyEpoch, "epochId" | "generation">, mode: "final" | "transfer"): Promise<void>;
  /** owner를 반납한다. 그 owner의 epoch이 모두 끝난다. */
  release(): Promise<void>;
}

interface Owner {
  readonly id: string;
  readonly heartbeat: ReturnType<typeof setInterval>;
  readonly events: AbortController;
}

export function createProxyBroker(deps: ProxyBrokerDeps): ProxyBroker {
  const fetchFor = deps.fetch ?? globalThis.fetch;
  let owner: Owner | null = null;
  let ownerCreation: Promise<Owner> | null = null;

  function request(path: string, init: { readonly method: string; readonly body?: unknown }): Promise<Response> {
    const origin = deps.localOrigin();
    const token = deps.lockToken();
    if (!origin || !token) return Promise.reject(new Error("proxy_broker_unavailable"));
    return fetchFor(`${origin}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  function lose(current: Owner, reason: string): void {
    if (owner !== current) return;
    owner = null;
    clearInterval(current.heartbeat);
    current.events.abort();
    deps.log?.(`proxy owner lost reason=${reason}`);
    deps.onOwnerLost(reason);
  }

  async function ensureOwner(): Promise<Owner> {
    if (owner) return owner;
    ownerCreation ??= (async () => {
      const response = await request(OWNERS_PATH, { method: "POST", body: {} });
      if (!response.ok) throw new Error(response.status === 404 ? "proxy_broker_absent" : "proxy_owner_refused");
      const body = await response.json() as { ownerLeaseId?: unknown; heartbeatMs?: unknown };
      if (!isDesktopProxyId(body.ownerLeaseId)) throw new Error("proxy_owner_refused");
      const heartbeatMs = typeof body.heartbeatMs === "number" && body.heartbeatMs >= 1_000 && body.heartbeatMs <= 60_000 ? body.heartbeatMs : DESKTOP_PROXY_HEARTBEAT_MS;
      const events = new AbortController();
      const id = body.ownerLeaseId;
      const created: Owner = {
        id,
        events,
        heartbeat: setInterval(() => {
          void request(`${OWNERS_PATH}/${encodeURIComponent(id)}/heartbeat`, { method: "POST", body: {} })
            .then((beat) => { if (beat.status === 410 || beat.status === 404) lose(created, "owner_expired"); })
            .catch(() => lose(created, "heartbeat_failed"));
        }, heartbeatMs),
      };
      owner = created;
      void listen(created);
      return created;
    })().finally(() => { ownerCreation = null; });
    return ownerCreation;
  }

  /** 이 owner의 상태 스트림. 끊기면 다시 붙지 않는다 — 그 사이 무엇이 끝났는지 모르므로 owner째로 끝낸다. */
  async function listen(current: Owner): Promise<void> {
    try {
      const origin = deps.localOrigin();
      const token = deps.lockToken();
      if (!origin || !token) throw new Error("proxy_broker_unavailable");
      const response = await fetchFor(`${origin}${EVENTS_PATH}?owner=${encodeURIComponent(current.id)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        redirect: "error",
        signal: current.events.signal,
      });
      if (!response.ok || !response.body) throw new Error(`proxy_events_status_${response.status}`);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        if (buffer.length > MAX_EVENT_CHARS * 4) throw new Error("proxy_events_oversize");
        let boundary: number;
        while ((boundary = buffer.search(/\r?\n\r?\n/u)) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/u, "");
          if (frame.length > MAX_EVENT_CHARS) throw new Error("proxy_events_oversize");
          handleFrame(frame);
        }
      }
      throw new Error("proxy_events_ended");
    } catch (error) {
      if (current.events.signal.aborted) return;
      lose(current, error instanceof Error ? error.message.slice(0, 64) : "proxy_events_failed");
    }
  }

  function handleFrame(frame: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/u)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (event !== DESKTOP_PROXY_EPOCH_STATE_EVENT || data.length === 0) return;
    let payload: unknown;
    try { payload = JSON.parse(data.join("\n")); } catch { return; }
    // 모양이 틀린 상태 프레임은 무엇이 끝났는지 말하지 못한다 — owner째로 끝낸다.
    if (!isDesktopProxyEpochStateEvent(payload)) throw new Error("proxy_events_malformed");
    if (payload.state !== "terminal") return;
    deps.onTerminal(payload.epochId, payload.generation, payload.reason ?? "protocol_error");
  }

  return {
    async delegate(delegation) {
      let current: Owner;
      try {
        current = await ensureOwner();
      } catch (error) {
        // broker가 없는 옛 Console이면 A′ 대상이 아니다. 그 밖의 실패는 실패다.
        if (error instanceof Error && error.message === "proxy_broker_absent") return { kind: "direct", reason: "broker_absent" };
        throw error;
      }
      const requestId = deps.randomId();
      const body = { requestId, ownerLeaseId: current.id, ...delegation };
      const response = await request(EPOCHS_PATH, { method: "POST", body });
      if (response.status === 404) {
        const code = await readError(response);
        if (code === "remote_host_unknown") throw new Error("remote_host_unknown");
        return { kind: "direct", reason: "broker_absent" };
      }
      if (response.status === 409) {
        const code = await readError(response);
        if ((DESKTOP_PROXY_DIRECT_FALLBACK_ERRORS as readonly string[]).includes(code)) return { kind: "direct", reason: code };
        throw new Error(code === "stale_switch" ? "surface_switch_superseded" : `proxy_${code}`);
      }
      if (response.status === 410) {
        lose(current, "owner_expired");
        throw new Error("proxy_owner_lease_expired");
      }
      if (response.status !== 201) throw new Error(`proxy_delegation_refused_${response.status}`);
      const epoch = parseEpoch(await response.json());
      if (!epoch) throw new Error("proxy_delegation_invalid");
      return { kind: "epoch", epoch };
    },

    async announceSwitch(generation) {
      const current = owner;
      if (!current) return;
      try {
        const response = await request(`${OWNERS_PATH}/${encodeURIComponent(current.id)}/switch`, { method: "POST", body: { switchGeneration: generation } });
        if (response.status === 410) lose(current, "owner_expired");
      } catch {
        // 알리지 못해도 옛 위임은 Desktop의 세대 검사가 한 번 더 막는다.
      }
    },

    async discard(epoch, mode) {
      const current = owner;
      if (!current) return;
      const query = `owner=${encodeURIComponent(current.id)}&generation=${epoch.generation}&mode=${mode}`;
      try {
        const response = await request(`${EPOCHS_PATH}/${encodeURIComponent(epoch.epochId)}?${query}`, { method: "DELETE" });
        if (!response.ok) deps.log?.(`proxy epoch discard refused status=${response.status}`);
      } catch (error) {
        deps.log?.(`proxy epoch discard failed: ${error instanceof Error ? error.message.slice(0, 64) : "unknown"}`);
      }
    },

    async release() {
      const current = owner;
      if (!current) return;
      owner = null;
      clearInterval(current.heartbeat);
      current.events.abort();
      try { await request(`${OWNERS_PATH}/${encodeURIComponent(current.id)}`, { method: "DELETE" }); } catch { /* lease는 곧 스스로 만료된다. */ }
    },
  };
}

function parseEpoch(value: unknown): ProxyEpoch | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (!isDesktopProxyId(entry.epochId)) return null;
  if (typeof entry.generation !== "number" || !Number.isSafeInteger(entry.generation)) return null;
  if (typeof entry.origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(entry.origin)) return null;
  if (typeof entry.cookieName !== "string" || entry.cookieName !== `fleet_epoch_${entry.epochId}`) return null;
  if (typeof entry.capability !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(entry.capability)) return null;
  return { epochId: entry.epochId, generation: entry.generation, origin: entry.origin, cookieName: entry.cookieName, capability: entry.capability };
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" && /^[a-z_]{1,64}$/u.test(body.error) ? body.error : "unknown";
  } catch {
    return "unknown";
  }
}
