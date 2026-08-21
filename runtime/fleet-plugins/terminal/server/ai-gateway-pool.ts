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

/**
 * How many "this one shares the Console gateway" decisions are remembered.
 *
 * Only the decision is kept — an id, not a router — because an Operation that launched shared has
 * nothing else to point at. It has to be remembered anyway: a second surface of the same
 * Operation asks again later, and re-reading the setting then would move a running Operation onto
 * a different router than the one its first surface is already using.
 *
 * The ceiling exists because these entries would otherwise accumulate for the life of a Console
 * that never deletes an Operation. Past it the oldest decision is forgotten, and an Operation
 * whose decision was forgotten is re-decided on its next claim; that is the exact defect this
 * memory closes, so the ceiling is set far above any believable count of live Operations.
 */
export const MAX_REMEMBERED_SHARED_PANELS = 512;

export interface DedicatedGatewayPool {
  /**
   * Give this operation its own router and return the panel id its child must send back.
   * Returns `""` when this operation shares the Console router — the setting was off when it
   * first asked, it carries no operation identity, or the pool was already at
   * {@link MAX_DEDICATED_GATEWAYS}.
   *
   * The decision is taken once per operation and then repeated, never re-evaluated. Both surfaces
   * of one Operation ask separately — the terminal launch and the Chat Mode session — and a
   * setting change between those two calls must not put them on different routers.
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
  const shared = new Set<string>();
  const decideShared = (operationId: string): string => {
    shared.add(operationId);
    // Insertion order is iteration order, so the first key is the oldest decision.
    if (shared.size > MAX_REMEMBERED_SHARED_PANELS) {
      const [oldest] = shared;
      if (oldest !== undefined) shared.delete(oldest);
    }
    return "";
  };
  return {
    claim: (operationId) => {
      if (!operationId || !isPanelId(operationId)) return "";
      // 이 Operation이 이미 답을 받았으면 그 답을 되풀이한다. 설정을 그 사이에 바꿔도 마찬가지다 —
      // 자식은 런치 때 구운 헤더를 계속 보내고, 같은 Operation의 두 표면(터미널·Chat)은 따로
      // 물어보므로, 여기서 다시 판단하면 한 Operation이 두 라우터로 갈라진다.
      if (routers.has(operationId)) return operationId;
      if (shared.has(operationId)) return "";
      let enabled: boolean;
      try {
        enabled = deps.enabled();
      } catch {
        // A settings read that fails must not fail the launch. The shared router is the default
        // and can always serve this panel, so fall back to it rather than refusing to start.
        // The failure is not recorded as a decision — the next surface deserves a real answer.
        return "";
      }
      if (!enabled) return decideShared(operationId);
      // 상한에 걸린 것도 결정이다. 기억하지 않으면 자리가 하나 나는 순간 이 Operation의 다음
      // 표면만 전용을 받아, 첫 표면이 쓰는 공용 라우터와 갈라진다.
      if (routers.size >= MAX_DEDICATED_GATEWAYS) return decideShared(operationId);
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
      // 결정은 그 Operation의 것이다. 삭제되면 결정도 함께 사라져야, 같은 id가 다시 나타나더라도
      // 그때의 설정으로 새로 판단한다.
      shared.delete(operationId);
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
      shared.clear();
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
