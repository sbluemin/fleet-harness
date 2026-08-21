import type { AiGatewayRouter } from "@dotobokuri/core-ai-gateway";

/**
 * Request header naming which panel a gateway request belongs to.
 *
 * The identity rides a header rather than the URL because `ANTHROPIC_BASE_URL` is not free to
 * vary per panel. Claude Code keeps one gateway model cache per Claude home and accepts it only
 * when its stored `baseUrl` equals the process's `ANTHROPIC_BASE_URL` exactly — measured in
 * 2.1.238, a mismatch returns an empty gateway model list with no live refresh. Panels share a
 * home, so a per-panel URL would leave every panel but the newest with an empty `/model` picker.
 * A header changes nothing the cache compares.
 *
 * Claude Code carries it through `ANTHROPIC_CUSTOM_HEADERS` (2.1.227+). An older CLI simply
 * drops it, and that panel falls back to the shared gateway — the behaviour it has always had.
 * The gateway never forwards it upstream: the Anthropic passthrough builds its headers from an
 * allowlist, and every other provider composes its own request.
 */
export const PANEL_GATEWAY_HEADER = "x-fleet-panel";

/** Env var Claude Code reads extra request headers from, as newline-separated `Name: Value`. */
const CUSTOM_HEADERS_ENV = "ANTHROPIC_CUSTOM_HEADERS";

/** Env var name, for callers that place the value into their own environment shape. */
export const PANEL_GATEWAY_HEADER_ENV = CUSTOM_HEADERS_ENV;

/**
 * The `ANTHROPIC_CUSTOM_HEADERS` value carrying this panel's identity, or `undefined` when the
 * launch has no panel of its own and the variable must stay as the caller found it.
 *
 * Returns a value rather than a merged environment because the two surfaces that need it hold
 * their env in different shapes — the PTY profile's values are all present, the Chat Mode child's
 * are a `ProcessEnv` — and one signature covering both would have to lie about one of them.
 *
 * The user's own headers are preserved rather than replaced, and a line already naming this
 * header is dropped first so a relaunch cannot stack two panel ids: Claude Code keeps the last
 * pair for a repeated name, and an inherited id would route this panel's turns onto another
 * panel's router.
 */
export function panelGatewayHeaderValue(
  current: string | undefined,
  panelId: string,
): string | undefined {
  if (panelId.length === 0) return undefined;
  const existing = (current ?? "")
    .split(/\r?\n/u)
    .filter((line) => {
      const at = line.indexOf(":");
      return at > 0 && line.slice(0, at).trim().toLowerCase() !== PANEL_GATEWAY_HEADER;
    })
    .filter((line) => line.trim().length > 0);
  return [...existing, `${PANEL_GATEWAY_HEADER}: ${panelId}`].join("\n");
}

/**
 * Upper bound on how many panel routers one Console keeps alive.
 *
 * Every router owns an upstream gate, a Cursor adapter, and the HTTP/2 sessions that adapter
 * dials, so the pool is real memory and real sockets rather than a bookkeeping map. The ceiling
 * is a backstop against a Console that accumulates panels faster than it releases them, not a
 * product limit: past it, further panels fall back to the shared router and keep working.
 */
export const MAX_DEDICATED_GATEWAYS = 32;

export interface DedicatedGatewayPool {
  /**
   * Give this operation its own router and return the panel id its child must send back.
   * Returns `""` when the launch shares the Console router — the setting is off, the launch
   * carries no operation identity, or the pool is already at {@link MAX_DEDICATED_GATEWAYS}.
   */
  readonly claim: (operationId: string | undefined) => string;
  /** The panel router this request names, or `undefined` when it names none. */
  readonly resolve: (headers: Readonly<Record<string, unknown>>) => AiGatewayRouter | undefined;
  readonly release: (operationId: string) => void;
  /** Live panel router count. Test and diagnostic surface only. */
  readonly size: () => number;
  readonly dispose: () => void;
}

export interface CreateDedicatedGatewayPoolDeps {
  /** Whether new launches get their own router. Read per launch, never cached. */
  readonly enabled: () => boolean;
  /** Builds one router. The pool passes nothing of its own — every dependency is the host's. */
  readonly createRouter: () => AiGatewayRouter;
}

export function createDedicatedGatewayPool(deps: CreateDedicatedGatewayPoolDeps): DedicatedGatewayPool {
  const routers = new Map<string, AiGatewayRouter>();
  return {
    claim: (operationId) => {
      if (!operationId || !isPanelId(operationId)) return "";
      // 이미 라우터를 가진 패널은 설정을 꺼도 자기 라우터로 돌아온다. 자식은 런치 때 구운 헤더를
      // 계속 보내므로, 여기서 공용으로 되돌리면 살아 있는 패널의 신원이 갈라진다.
      if (routers.has(operationId)) return operationId;
      let enabled: boolean;
      try {
        enabled = deps.enabled();
      } catch {
        // A settings read that fails must not fail the launch. The shared router is the default
        // and can always serve this panel, so fall back to it rather than refusing to start.
        return "";
      }
      if (!enabled) return "";
      if (routers.size >= MAX_DEDICATED_GATEWAYS) return "";
      routers.set(operationId, deps.createRouter());
      return operationId;
    },
    /**
     * Deliberately a lookup and never a create: the header is caller-supplied, so admitting an
     * unknown id here would let anything holding the gateway credential mint routers without
     * limit. A miss is also the honest answer after a Console restart — a panel launched before
     * it still sends its old id, and falling back to the shared router keeps that turn alive.
     */
    resolve: (headers) => {
      const raw = headers[PANEL_GATEWAY_HEADER];
      if (typeof raw !== "string") return undefined;
      const panelId = raw.trim();
      return isPanelId(panelId) ? routers.get(panelId) : undefined;
    },
    release: (operationId) => {
      const router = routers.get(operationId);
      if (!router) return;
      routers.delete(operationId);
      try {
        router.dispose();
      } catch {
        // Disposal is best effort. A provider that throws on teardown must not leave the pool
        // holding a router whose panel no longer exists to use it.
      }
    },
    size: () => routers.size,
    dispose: () => {
      for (const router of routers.values()) {
        try {
          router.dispose();
        } catch {
          // Same reason as release: one provider's teardown must not abort the rest.
        }
      }
      routers.clear();
    },
  };
}

/**
 * Operation ids are host-issued and opaque. Constrain them here anyway: the value has to survive
 * a `Name: Value` header line intact, so a newline, a colon, or surrounding space would either
 * split the pair or name a panel other than its own.
 */
function isPanelId(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  return /^[A-Za-z0-9._-]+$/u.test(value);
}
