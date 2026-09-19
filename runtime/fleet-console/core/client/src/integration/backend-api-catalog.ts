// The backend API catalog: the one fetch that reads it and the store the Settings
// surface subscribes to. The store was the fetch's only caller.

import { useSyncExternalStore } from "react";
import type { ApiCatalogEntry } from "./types.js";
import { ApiError } from "./api.js";

// ─── fetch ─────────────────────────────────────────────────────────────────────

interface ApiCatalogResponse {
  readonly version: unknown;
  readonly routes: unknown;
}

export async function fetchApiCatalog(signal?: AbortSignal): Promise<readonly ApiCatalogEntry[]> {
  const response = await fetch("/api/v1/settings/api-catalog", { signal });
  await assertOk(response);
  return assertApiCatalogResponse(await response.json(), response.status).routes;
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string") message = payload.error;
  } catch {
    // 응답 본문이 JSON이 아니면 statusText를 사용한다.
  }
  throw new ApiError(response.status, message);
}

function assertApiCatalogResponse(value: unknown, status: number): { readonly routes: readonly ApiCatalogEntry[] } {
  const payload = value as Partial<ApiCatalogResponse>;
  if (!payload || typeof payload !== "object" || !("version" in payload) || !Array.isArray(payload.routes)) {
    throw new ApiError(status, "Invalid backend API catalog response");
  }
  return { routes: payload.routes.map((route) => assertApiCatalogEntry(route, status)) };
}

function assertApiCatalogEntry(value: unknown, status: number): ApiCatalogEntry {
  const entry = value as Partial<ApiCatalogEntry>;
  if (
    !entry ||
    typeof entry !== "object" ||
    !isApiCatalogMethod(entry.method) ||
    typeof entry.path !== "string" ||
    typeof entry.summary !== "string" ||
    typeof entry.category !== "string" ||
    !isApiCatalogGate(entry.gate) ||
    !isApiCatalogTransport(entry.transport)
  ) {
    throw new ApiError(status, "Invalid backend API catalog entry");
  }
  return {
    method: entry.method,
    path: entry.path,
    summary: entry.summary,
    category: entry.category,
    gate: entry.gate,
    transport: entry.transport,
  };
}

function isApiCatalogMethod(value: unknown): value is ApiCatalogEntry["method"] {
  return value === "GET" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE" || value === "*";
}

function isApiCatalogGate(value: unknown): value is ApiCatalogEntry["gate"] {
  return value === "loopback" || value === "origin-write" || value === "origin-strict" || value === "lock-token" || value === "anthropic-credential" || value === "one-use-ticket";
}

function isApiCatalogTransport(value: unknown): value is ApiCatalogEntry["transport"] {
  return value === "http" || value === "sse" || value === "websocket" || value === "proxy";
}

// ─── store ─────────────────────────────────────────────────────────────────────

interface ApiCatalogStoreState {
  readonly loading: boolean;
  readonly state: readonly ApiCatalogEntry[] | null;
  readonly error: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: ApiCatalogStoreState = {
  loading: false,
  state: null,
  error: null,
};

export function useApiCatalogStore(): ApiCatalogStoreState {
  return useSyncExternalStore(subscribe, getApiCatalogStoreState, getApiCatalogStoreState);
}

function getApiCatalogStoreState(): ApiCatalogStoreState {
  return snapshot;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadApiCatalog(signal?: AbortSignal): Promise<void> {
  setSnapshot({ loading: true, error: null });
  try {
    const state = await fetchApiCatalog(signal);
    setSnapshot({ loading: false, state, error: null });
  } catch (error) {
    if (signal?.aborted) return;
    setSnapshot({ loading: false, error: toErrorMessage(error) });
  }
}

function setSnapshot(patch: Partial<ApiCatalogStoreState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
