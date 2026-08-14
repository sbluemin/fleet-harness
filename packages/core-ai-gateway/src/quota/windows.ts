/**
 * Provider-neutral quota vocabulary and probe plumbing shared by the
 * per-provider usage readers (`src/<provider>/quota.ts`).
 *
 * Probe URLs, credential procurement, and response parsing are provider
 * knowledge and live beside each provider. What belongs here is only what every
 * probe shares: window normalization, bounded request I/O, error sanitization,
 * and the deps shape collectors receive. Nothing in this module is allowed to
 * construct a default auth path — collectors are handed their auth and
 * credential dependencies explicitly.
 */

import type { AuthService } from "@dotobokuri/core-infra";
import { findCauseCode } from "../transport/upstream-sse.js";
import type { CredentialResolverDeps } from "../transport/credentials.js";
import type { ProviderDto, QuotaWindowPeriod, WindowDurationBasis } from "./types.js";

export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 262_144;
export const MAX_WINDOWS = 8;
export const MAX_CREDIT_ENTRIES = 256;
export const TLS_CERT_ERROR_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

export const HOUR_MS = 3_600_000;
export const WEEK_MS = 7 * 24 * HOUR_MS;
export const MAX_WINDOW_DURATION_MS = 400 * 24 * HOUR_MS;

export interface ProviderDeps {
  readonly credentials?: CredentialResolverDeps;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /**
   * Kimi is reached with the key Fleet itself stores, not another CLI's
   * credential file, so it reads through core-infra's auth surface — which owns
   * the file's shape and its symlink-guarded read — instead of parsing the file here.
   */
  readonly authService?: AuthService;
}

export function windowPeriod(
  durationMs: number,
  durationBasis: WindowDurationBasis,
  resetsAt?: number,
): QuotaWindowPeriod | undefined {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_WINDOW_DURATION_MS) return undefined;
  const rounded = Math.round(durationMs);
  // A fixed contiguous window starts one duration before it resets; the
  // `derived` tag keeps that assumption visible instead of passing it off as
  // an observed start.
  const startsAt = resetsAt !== undefined && resetsAt > rounded ? resetsAt - rounded : undefined;
  return {
    durationMs: rounded,
    durationBasis,
    ...(startsAt !== undefined ? { startsAt, startsAtBasis: "derived" as const } : {}),
  };
}

class ProviderHttpError extends Error {
  constructor(readonly statusCode?: number) {
    super(statusCode === undefined ? "Provider request failed" : `Provider request failed (${statusCode})`);
  }
}

class ProviderResponseTooLargeError extends Error {
  constructor() {
    super("Provider response too large");
  }
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function safeTimestamp(value: unknown): number | undefined {
  let result: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) result = value < 1e12 ? value * 1_000 : value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[1-9]\d{9,14}$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) result = parsed < 1e12 ? parsed * 1_000 : parsed;
    } else {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) result = parsed;
    }
  }
  if (result === undefined || !Number.isFinite(result) || result < 0) return undefined;
  const rounded = Math.round(result);
  return Number.isSafeInteger(rounded) ? rounded : undefined;
}

export function percent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function validatedString(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) return undefined;
  if (/^bearer /i.test(trimmed)) return undefined;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return undefined;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(trimmed)) return undefined;
  return trimmed;
}

export function titleCase(value: unknown): string | undefined {
  const validated = validatedString(value, /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,23}$/);
  if (!validated) return undefined;
  // Plan labels deliberately exclude money, so a bare number must never enter the DTO.
  if (/^\d+$/.test(validated)) return undefined;
  return `${validated[0]?.toUpperCase() ?? ""}${validated.slice(1)}`;
}

export function modelLabel(value: unknown): string {
  return validatedString(value, /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,39}$/) ?? "Model";
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      redirect: "error",
    });
    if (response.url !== "" && response.url !== url) throw new ProviderHttpError();
    if (!response.ok) throw new ProviderHttpError(response.status);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      controller.abort();
      throw new ProviderResponseTooLargeError();
    }
    if (!response.body) {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new ProviderResponseTooLargeError();
      }
      return JSON.parse(text);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new ProviderResponseTooLargeError();
      }
      chunks.push(value);
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body));
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(fetchImpl: typeof fetch, url: string, headers: HeadersInit): Promise<unknown> {
  return requestJson(fetchImpl, url, { method: "GET", headers });
}

export async function postJson(fetchImpl: typeof fetch, url: string, headers: HeadersInit): Promise<unknown> {
  return requestJson(fetchImpl, url, { method: "POST", headers, body: "{}" });
}

export function expired(error: unknown): ProviderDto | null {
  return error instanceof ProviderHttpError && (error.statusCode === 401 || error.statusCode === 403)
    ? { status: "expired" }
    : null;
}

export function sanitizeProviderError(error: unknown): string {
  if (error instanceof ProviderResponseTooLargeError) return "Provider response too large";
  if (error instanceof DOMException && error.name === "AbortError") return "Provider request timed out";
  if (error instanceof ProviderHttpError && error.statusCode !== undefined) {
    return `Provider request failed (${error.statusCode})`;
  }
  // TLS 검사 프록시 등 인증서 검증 실패는 원인 코드를 남긴다 — 일반화하면 사용자가 원인을 찾을 수 없다(issue #531).
  const causeCode = findCauseCode(error);
  if (causeCode !== undefined && TLS_CERT_ERROR_CODES.has(causeCode)) {
    return `Certificate verification failed (${causeCode})`;
  }
  return "Provider request failed";
}
