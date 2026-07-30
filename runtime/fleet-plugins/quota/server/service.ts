import { fetchClaudeUsage, fetchCodexUsage, sanitizeProviderError } from "./providers.js";
import type { ProviderDto, ProviderResult, ProviderSuccess, QuotaSummaryDto } from "./types.js";

const CACHE_TTL_MS = 120_000;
const STALE_TTL_MS = 1_800_000;

type ProviderId = "claude" | "codex";

export interface QuotaService {
  getSummary(options?: { readonly force?: boolean }): Promise<QuotaSummaryDto>;
}

export interface QuotaServiceDeps {
  readonly isClaudeConnected: () => Promise<boolean>;
  readonly fetchClaude?: () => Promise<ProviderResult>;
  readonly fetchCodex?: () => Promise<ProviderResult>;
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
  };
  const cache = new Map<ProviderId, CacheEntry>();
  const lastGood = new Map<ProviderId, ProviderSuccess>();
  const inFlight = new Map<ProviderId, Promise<ProviderDto>>();

  async function load(id: ProviderId, force: boolean): Promise<ProviderDto> {
    if (id === "claude" && !await deps.isClaudeConnected()) {
      return { status: "not_connected", method: (deps.platform ?? process.platform) === "darwin" ? "keychain" : "file" };
    }
    const cached = cache.get(id);
    if (!force && cached && cached.expiresAt > now()) return cached.value;
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
        const value: ProviderDto = previous && now() - previous.fetchedAt <= STALE_TTL_MS
          ? { ...previous, status: "stale", message }
          : { status: "error", message };
        cache.set(id, { value, expiresAt: now() + CACHE_TTL_MS });
        return value;
      })
      .finally(() => inFlight.delete(id));
    inFlight.set(id, task);
    return task;
  }

  return {
    async getSummary(options = {}) {
      const [claude, codex] = await Promise.all([
        load("claude", options.force === true),
        load("codex", options.force === true),
      ]);
      return { providers: { claude, codex } };
    },
  };
}

export const quotaServiceConstants = { CACHE_TTL_MS, STALE_TTL_MS } as const;
