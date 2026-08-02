import {
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchCursorUsage,
  fetchKimiUsage,
  sanitizeProviderError,
} from "./providers.js";
import type { ProviderDto, ProviderResult, ProviderSuccess, QuotaSummaryDto } from "./types.js";

const CACHE_TTL_MS = 120_000;
const STALE_TTL_MS = 1_800_000;

type ProviderId = "claude" | "codex" | "cursor" | "kimi";

export interface QuotaService {
  getSummary(options?: {
    readonly force?: boolean;
    readonly forceProvider?: ProviderId;
  }): Promise<QuotaSummaryDto>;
}

export interface QuotaServiceDeps {
  readonly isClaudeConnected: () => Promise<boolean>;
  readonly isCursorConnected: () => Promise<boolean>;
  readonly fetchClaude?: () => Promise<ProviderResult>;
  readonly fetchCodex?: () => Promise<ProviderResult>;
  readonly fetchCursor?: () => Promise<ProviderResult>;
  readonly fetchKimi?: () => Promise<ProviderResult>;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
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
    claude: deps.fetchClaude ?? (() => fetchClaudeUsage()),
    codex: deps.fetchCodex ?? (() => fetchCodexUsage()),
    cursor: deps.fetchCursor ?? (() => fetchCursorUsage()),
    kimi: deps.fetchKimi ?? (() => fetchKimiUsage()),
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

  return {
    async getSummary(options = {}) {
      const [claude, codex, cursor, kimi] = await Promise.all([
        load("claude", options.force === true || options.forceProvider === "claude"),
        load("codex", options.force === true || options.forceProvider === "codex"),
        load("cursor", options.force === true || options.forceProvider === "cursor"),
        load("kimi", options.force === true || options.forceProvider === "kimi"),
      ]);
      return { providers: { claude, codex, cursor, kimi } };
    },
  };
}

export const quotaServiceConstants = { CACHE_TTL_MS, STALE_TTL_MS } as const;
