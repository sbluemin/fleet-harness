import type http from "node:http";

import type {
  TheaterRowBadge,
  TheaterRowBadgeContribution,
  TheaterRowBadgeProvider,
  TheaterRowBadgeTone,
} from "@fleet-console/sdk/plugin";

export const THEATER_ROW_BADGE_PROVIDER_TIMEOUT_MS = 800;
export const THEATER_ROW_BADGE_DEADLINE_MS = 3_000;
export const THEATER_ROW_BADGE_MAX_CONCURRENCY = 4;
export const MAX_THEATER_ROW_BADGES = 8;
export const MAX_THEATER_ROW_BADGE_ID_LENGTH = 64;
export const MAX_THEATER_ROW_BADGE_TEXT_LENGTH = 80;
export const MAX_THEATER_ROW_BADGE_ARIA_LABEL_LENGTH = 160;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const ABSOLUTE_PATH_PATTERN = /^(?:\/|\\\\|[a-zA-Z]:[\\/]|file:\/\/)/u;
const BADGE_TONES = new Set<TheaterRowBadgeTone>(["neutral", "info", "warn", "positive"]);

export interface TheaterRowBadgeRegistry {
  register(pluginId: string, provider: TheaterRowBadgeProvider): () => void;
  resolve(theaterIds: readonly string[]): Promise<readonly TheaterRowBadgeContribution[]>;
}

interface ResolveOptions {
  readonly maxConcurrency?: number;
  readonly providerTimeoutMs?: number;
  readonly deadlineMs?: number;
}

interface TheaterRowBadgeRouteDeps {
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly listTheaterIds: () => readonly string[];
  readonly resolve: (theaterIds: readonly string[]) => Promise<readonly TheaterRowBadgeContribution[]>;
  readonly writeJson: (res: http.ServerResponse, status: number, payload: unknown) => void;
}

export function createTheaterRowBadgeRegistry(): TheaterRowBadgeRegistry {
  const providers = new Map<string, TheaterRowBadgeProvider[]>();

  return {
    register(pluginId, provider) {
      const registered = providers.get(pluginId) ?? [];
      registered.push(provider);
      providers.set(pluginId, registered);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        const current = providers.get(pluginId);
        if (!current) return;
        const index = current.indexOf(provider);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) providers.delete(pluginId);
      };
    },
    resolve(theaterIds) {
      return resolveTheaterRowBadges(
        [...providers.values()].flat(),
        theaterIds,
      );
    },
  };
}

export async function handleTheaterRowBadges(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: TheaterRowBadgeRouteDeps,
): Promise<void> {
  if (req.method !== "GET") {
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  const theaterIds = deps.listTheaterIds();
  deps.writeJson(res, 200, { theaters: await deps.resolve(theaterIds) });
}

export async function resolveTheaterRowBadges(
  providers: readonly TheaterRowBadgeProvider[],
  theaterIds: readonly string[],
  options: ResolveOptions = {},
): Promise<readonly TheaterRowBadgeContribution[]> {
  if (providers.length === 0 || theaterIds.length === 0) return [];
  const maxConcurrency = options.maxConcurrency ?? THEATER_ROW_BADGE_MAX_CONCURRENCY;
  const providerTimeoutMs = options.providerTimeoutMs ?? THEATER_ROW_BADGE_PROVIDER_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? THEATER_ROW_BADGE_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  const results: unknown[] = [];
  const activeControllers = new Set<AbortController>();
  let nextIndex = 0;

  const deadlineTimer = setTimeout(() => {
    for (const controller of activeControllers) controller.abort();
  }, deadlineMs);
  const worker = async () => {
    while (nextIndex < providers.length) {
      if (Date.now() >= deadlineAt) return;
      const index = nextIndex;
      nextIndex += 1;
      const provider = providers[index];
      if (!provider) continue;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) return;
      const controller = new AbortController();
      activeControllers.add(controller);
      const timeoutMs = Math.min(providerTimeoutMs, remainingMs);
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => provider({ theaterIds, signal: controller.signal })),
          waitForAbort(controller.signal),
        ]);
        if (!controller.signal.aborted) results.push(value);
      } catch {
        // 한 provider의 실패는 다른 provider의 결과를 막지 않는다.
      } finally {
        clearTimeout(timeout);
        activeControllers.delete(controller);
      }
    }
  };

  try {
    await Promise.all(
      Array.from(
        { length: Math.min(maxConcurrency, providers.length) },
        () => worker(),
      ),
    );
  } finally {
    clearTimeout(deadlineTimer);
    for (const controller of activeControllers) controller.abort();
  }
  return sanitizeTheaterRowBadgeContributions(results, theaterIds);
}

export function sanitizeTheaterRowBadgeContributions(
  values: readonly unknown[],
  knownTheaterIds: readonly string[],
): readonly TheaterRowBadgeContribution[] {
  const known = new Set(knownTheaterIds);
  const byTheater = new Map<string, TheaterRowBadge[]>();

  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const contribution of value) {
      if (!isObject(contribution) || typeof contribution.theaterId !== "string" || !known.has(contribution.theaterId) || !Array.isArray(contribution.badges)) continue;
      const badges = byTheater.get(contribution.theaterId) ?? [];
      const seenIds = new Set(badges.map((badge) => badge.id));
      for (const candidate of contribution.badges) {
        if (badges.length >= MAX_THEATER_ROW_BADGES) break;
        const badge = sanitizeBadge(candidate);
        if (!badge || seenIds.has(badge.id)) continue;
        badges.push(badge);
        seenIds.add(badge.id);
      }
      if (badges.length > 0) byTheater.set(contribution.theaterId, badges);
    }
  }

  return knownTheaterIds.flatMap((theaterId) => {
    const badges = byTheater.get(theaterId);
    return badges ? [{ theaterId, badges }] : [];
  });
}

function sanitizeBadge(value: unknown): TheaterRowBadge | null {
  if (!isObject(value)) return null;
  const id = sanitizeString(value.id, MAX_THEATER_ROW_BADGE_ID_LENGTH);
  const text = sanitizeString(value.text, MAX_THEATER_ROW_BADGE_TEXT_LENGTH);
  if (!id || !text) return null;
  const ariaLabel = value.ariaLabel === undefined
    ? undefined
    : sanitizeString(value.ariaLabel, MAX_THEATER_ROW_BADGE_ARIA_LABEL_LENGTH);
  if (value.ariaLabel !== undefined && !ariaLabel) return null;
  const tone = value.tone === undefined
    ? undefined
    : typeof value.tone === "string" && BADGE_TONES.has(value.tone as TheaterRowBadgeTone)
      ? value.tone as TheaterRowBadgeTone
      : null;
  if (tone === null) return null;
  return {
    id,
    text,
    ...(ariaLabel ? { ariaLabel } : {}),
    ...(tone ? { tone } : {}),
  };
}

function sanitizeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  if (CONTROL_CHARACTER_PATTERN.test(value) || ABSOLUTE_PATH_PATTERN.test(value.trim())) return null;
  return value;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
