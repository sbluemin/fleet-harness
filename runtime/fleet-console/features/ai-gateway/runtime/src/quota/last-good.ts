import { createDurableJsonStore } from "@fleet-console/infra";

import type { CredentialMethod, ProviderSuccess, QuotaScope, QuotaWindow, ResetCredits, WindowId } from "./types.js";
import { titleCase } from "./windows.js";

/**
 * 공급자별 마지막 성공 사용량. 자리는 호스트가 넘긴다 — 이 모듈은 데이터 루트를 찾지 않는다.
 * 자격·토큰·key 응답 원본은 항목에 없다. 깨진 파일은 빈 스냅샷으로 읽는다.
 */
export interface QuotaLastGoodStore {
  read(): Partial<Record<QuotaLastGoodProviderId, ProviderSuccess>>;
  write(providers: Partial<Record<QuotaLastGoodProviderId, ProviderSuccess>>): void;
}

export const QUOTA_LAST_GOOD_PROVIDERS = [
  "antigravity",
  "claude",
  "codex",
  "cursor",
  "muse-code",
  "xai",
] as const;

export type QuotaLastGoodProviderId = (typeof QUOTA_LAST_GOOD_PROVIDERS)[number];

const WINDOW_IDS: readonly WindowId[] = ["session", "weekly", "model", "cycle"];
const SCOPES: readonly QuotaScope[] = ["auto"];

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeTime(value: unknown): number | undefined {
  const time = finite(value);
  return time !== undefined && Number.isSafeInteger(time) ? time : undefined;
}

function shortLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return undefined;
  if (/[\r\n]/.test(trimmed) || /^bearer /i.test(trimmed)) return undefined;
  return trimmed;
}

function sanitizeWindow(value: unknown): QuotaWindow | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const window = value as Record<string, unknown>;
  if (!WINDOW_IDS.includes(window.id as WindowId)) return undefined;
  const usedPercent = finite(window.usedPercent);
  if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) return undefined;
  const scope = SCOPES.includes(window.scope as QuotaScope) ? window.scope as QuotaScope : undefined;
  const label = shortLabel(window.label);
  const resetsAt = safeTime(window.resetsAt);
  let period: QuotaWindow["period"];
  if (typeof window.period === "object" && window.period !== null && !Array.isArray(window.period)) {
    const raw = window.period as Record<string, unknown>;
    const durationMs = finite(raw.durationMs);
    const durationBasis = raw.durationBasis === "upstream" || raw.durationBasis === "catalog" ? raw.durationBasis : undefined;
    if (durationMs !== undefined && durationMs > 0 && durationBasis !== undefined) {
      const startsAt = safeTime(raw.startsAt);
      const startsAtBasis = raw.startsAtBasis === "upstream" || raw.startsAtBasis === "derived" ? raw.startsAtBasis : undefined;
      period = {
        durationMs,
        durationBasis,
        ...(startsAt !== undefined ? { startsAt } : {}),
        ...(startsAtBasis !== undefined ? { startsAtBasis } : {}),
      };
    }
  }
  let amounts: QuotaWindow["amounts"];
  if (typeof window.amounts === "object" && window.amounts !== null && !Array.isArray(window.amounts)) {
    const raw = window.amounts as Record<string, unknown>;
    if (typeof raw.used === "string" && typeof raw.limit === "string"
      && /^[0-9]+(?:\.[0-9]+)?$/.test(raw.used) && /^[0-9]+(?:\.[0-9]+)?$/.test(raw.limit)
      && raw.used.length <= 32 && raw.limit.length <= 32) {
      amounts = { used: raw.used, limit: raw.limit };
    }
  }
  return {
    id: window.id as WindowId,
    usedPercent,
    ...(scope ? { scope } : {}),
    ...(label ? { label } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(period ? { period } : {}),
    ...(window.isAggregate === true ? { isAggregate: true } : {}),
    ...(amounts ? { amounts } : {}),
  };
}

function sanitizeCredits(value: unknown): ResetCredits | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const credits = value as Record<string, unknown>;
  const available = finite(credits.available);
  if (available === undefined || available < 0 || !Number.isSafeInteger(available)) return undefined;
  const nextExpiresAt = safeTime(credits.nextExpiresAt);
  return { available, ...(nextExpiresAt !== undefined ? { nextExpiresAt } : {}) };
}

function sanitizeSuccess(value: unknown): ProviderSuccess | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.status !== "ok" || !Array.isArray(record.windows)) return undefined;
  const fetchedAt = safeTime(record.fetchedAt);
  if (fetchedAt === undefined) return undefined;
  const windows = record.windows.map(sanitizeWindow).filter((window): window is QuotaWindow => window !== undefined);
  if (windows.length === 0) return undefined;
  const plan = titleCase(record.plan);
  const method: CredentialMethod | undefined = record.method === "keychain" || record.method === "file" ? record.method : undefined;
  const cycleDays = safeTime(record.cycleDays);
  const credits = sanitizeCredits(record.credits);
  return {
    status: "ok",
    fetchedAt,
    windows,
    ...(plan ? { plan } : {}),
    ...(method ? { method } : {}),
    ...(cycleDays !== undefined && cycleDays > 0 ? { cycleDays } : {}),
    ...(credits ? { credits } : {}),
  };
}

interface QuotaLastGoodDocument {
  readonly version: 1;
  readonly providers: Partial<Record<QuotaLastGoodProviderId, ProviderSuccess>>;
}

function sanitizeDocument(value: unknown): QuotaLastGoodDocument {
  const empty: QuotaLastGoodDocument = { version: 1, providers: {} };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return empty;
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || typeof root.providers !== "object" || root.providers === null || Array.isArray(root.providers)) {
    return empty;
  }
  const providers: Partial<Record<QuotaLastGoodProviderId, ProviderSuccess>> = {};
  const raw = root.providers as Record<string, unknown>;
  for (const id of QUOTA_LAST_GOOD_PROVIDERS) {
    const success = sanitizeSuccess(raw[id]);
    if (success) providers[id] = success;
  }
  return { version: 1, providers };
}

export function createQuotaLastGoodStore(deps: { readonly filePath: string }): QuotaLastGoodStore {
  const store = createDurableJsonStore<QuotaLastGoodDocument>({
    filePath: deps.filePath,
    lockDir: `${deps.filePath}.lock`,
    lockOwnerFileName: "owner.json",
    sanitize: sanitizeDocument,
    sensitivity: "sensitive",
    tempCleanupPrefix: "quota-last-good.json.",
  });
  return {
    read: () => store.load().providers,
    write(providers) {
      store.save({ version: 1, providers });
    },
  };
}
