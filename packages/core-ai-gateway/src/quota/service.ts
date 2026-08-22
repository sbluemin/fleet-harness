import type { AuthService } from "@dotobokuri/core-infra";

import { fetchClaudeUsage } from "../anthropic/quota.js";
import { fetchCodexUsage } from "../codex/quota.js";
import { fetchCursorUsage } from "../cursor/quota.js";
import { fetchKimiUsage } from "../kimi/quota.js";
import { fetchOpencodeUsage } from "../opencode-go/quota.js";
import { fetchXaiUsage } from "../xai/quota.js";
import { defaultCredentialDeps, type CredentialResolverDeps } from "../transport/credentials.js";
import { deriveQuotaWindowRisk } from "./pressure.js";
import type { ProviderDto, ProviderResult, ProviderSuccess, QuotaSummaryDto } from "./types.js";
import { sanitizeProviderError, type ProviderDeps } from "./windows.js";

const CACHE_TTL_MS = 120_000;
const STALE_TTL_MS = 1_800_000;

type ProviderId = "claude" | "codex" | "cursor" | "kimi" | "opencode" | "xai";

export interface QuotaService {
  getSummary(options?: {
    readonly force?: boolean;
    readonly forceProvider?: ProviderId;
  }): Promise<QuotaSummaryDto>;
}

export interface QuotaServiceDeps {
  readonly isClaudeConnected: () => Promise<boolean>;
  readonly isCursorConnected: () => Promise<boolean>;
  readonly fetchClaude: () => Promise<ProviderResult>;
  readonly fetchCodex: () => Promise<ProviderResult>;
  readonly fetchCursor: () => Promise<ProviderResult>;
  readonly fetchKimi: () => Promise<ProviderResult>;
  readonly fetchOpencode: () => Promise<ProviderResult>;
  readonly fetchXai?: () => Promise<ProviderResult>;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
}

/**
 * Deps for building the provider probes. `authService` is required here —
 * Kimi and OpenCode Go read the keys Fleet itself stores through it — so a host
 * that composes these collectors can never silently fall back to constructing a
 * default auth path inside the package.
 */
export interface AiGatewayQuotaCollectorDeps {
  readonly authService: AuthService;
  readonly credentialDeps?: CredentialResolverDeps;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface AiGatewayQuotaCollectors {
  readonly fetchClaude: () => Promise<ProviderResult>;
  readonly fetchCodex: () => Promise<ProviderResult>;
  readonly fetchCursor: () => Promise<ProviderResult>;
  readonly fetchKimi: () => Promise<ProviderResult>;
  readonly fetchOpencode: () => Promise<ProviderResult>;
  readonly fetchXai: () => Promise<ProviderResult>;
}

export function createAiGatewayQuotaCollectors(deps: AiGatewayQuotaCollectorDeps): AiGatewayQuotaCollectors {
  const providerDeps: ProviderDeps = {
    credentials: deps.credentialDeps ?? defaultCredentialDeps,
    authService: deps.authService,
    ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  return {
    fetchClaude: () => fetchClaudeUsage(providerDeps),
    fetchCodex: () => fetchCodexUsage(providerDeps),
    fetchCursor: () => fetchCursorUsage(providerDeps),
    fetchKimi: () => fetchKimiUsage(providerDeps),
    fetchOpencode: () => fetchOpencodeUsage(providerDeps),
    fetchXai: () => fetchXaiUsage(providerDeps),
  };
}

interface CacheEntry {
  readonly value: ProviderDto;
  readonly expiresAt: number;
}

function isProviderSuccess(value: ProviderResult): value is ProviderSuccess {
  return value.status === "ok"
    && Array.isArray(value.windows)
    && typeof value.fetchedAt === "number";
}

export function createQuotaService(deps: QuotaServiceDeps): QuotaService {
  const now = deps.now ?? Date.now;
  const fetchers: Record<ProviderId, () => Promise<ProviderResult>> = {
    claude: deps.fetchClaude,
    codex: deps.fetchCodex,
    cursor: deps.fetchCursor,
    kimi: deps.fetchKimi,
    opencode: deps.fetchOpencode,
    xai: deps.fetchXai ?? (async () => ({ status: "signed_out" })),
  };
  const cache = new Map<ProviderId, CacheEntry>();
  const lastGood = new Map<ProviderId, ProviderSuccess>();
  const inFlight = new Map<ProviderId, Promise<ProviderDto>>();

  async function load(id: ProviderId, force: boolean): Promise<ProviderDto> {
    if (
      (id === "claude" && !await deps.isClaudeConnected())
      || (id === "cursor" && !await deps.isCursorConnected())
    ) {
      return { status: "not_connected", method: (deps.platform ?? process.platform) === "darwin" ? "keychain" : "file" };
    }
    const cached = cache.get(id);
    if (!force && cached && cached.expiresAt > now()) {
      const staleStillValid = cached.value.status !== "stale"
        || (
          typeof cached.value.fetchedAt === "number"
          && now() - cached.value.fetchedAt <= STALE_TTL_MS
        );
      if (staleStillValid) return cached.value;
      cache.delete(id);
    }
    const pending = inFlight.get(id);
    if (pending) return pending;
    const task = fetchers[id]()
      .then((value) => {
        if (isProviderSuccess(value)) lastGood.set(id, value);
        cache.set(id, { value, expiresAt: now() + CACHE_TTL_MS });
        return value;
      })
      .catch((error: unknown) => {
        const previous = lastGood.get(id);
        const message = sanitizeProviderError(error);
        const failedAt = now();
        const value: ProviderDto = previous && failedAt - previous.fetchedAt <= STALE_TTL_MS
          ? { ...previous, status: "stale", message }
          : { status: "error", message };
        const expiresAt = value.status === "stale" && previous
          ? Math.min(failedAt + CACHE_TTL_MS, previous.fetchedAt + STALE_TTL_MS)
          : failedAt + CACHE_TTL_MS;
        cache.set(id, { value, expiresAt });
        return value;
      })
      .finally(() => inFlight.delete(id));
    inFlight.set(id, task);
    return task;
  }

  /**
   * Risk is derived against `fetchedAt` rather than the current clock: a
   * summary can be served from cache for minutes, and re-timing the reading on
   * every read would let pace decay while nothing was actually spent.
   */
  function withRisk(provider: ProviderDto): ProviderDto {
    if (!provider.windows || provider.windows.length === 0) return provider;
    const at = typeof provider.fetchedAt === "number" && Number.isFinite(provider.fetchedAt)
      ? provider.fetchedAt
      : now();
    return {
      ...provider,
      windows: provider.windows.map((window) => ({ ...window, risk: deriveQuotaWindowRisk(window, at) })),
    };
  }

  return {
    async getSummary(options = {}) {
      const [claude, codex, cursor, kimi, opencode, xai] = await Promise.all([
        load("claude", options.force === true || options.forceProvider === "claude"),
        load("codex", options.force === true || options.forceProvider === "codex"),
        load("cursor", options.force === true || options.forceProvider === "cursor"),
        load("kimi", options.force === true || options.forceProvider === "kimi"),
        load("opencode", options.force === true || options.forceProvider === "opencode"),
        load("xai", options.force === true || options.forceProvider === "xai"),
      ]);
      return {
        providers: {
          claude: withRisk(claude),
          codex: withRisk(codex),
          cursor: withRisk(cursor),
          kimi: withRisk(kimi),
          opencode: withRisk(opencode),
          xai: withRisk(xai),
        },
      };
    },
  };
}
