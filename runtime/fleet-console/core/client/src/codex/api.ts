// 서버 응답 DTO는 api-types.ts(타입 전용 파일)를 단일 출처로 공유한다.
// 같은 패키지 서버 코드의 type-only import이므로 Vite 번들에는 포함되지 않는다.
import type {
  ConflictDetailResponse,
  ConflictListItem,
  DrydockDetailResponse,
  DrydockListItem,
  DrydockListResponse,
  DrydockMeta,
  EntryFrontmatter,
  EntryResponse,
  SearchEntry,
  SearchResponse,
} from "../../../host/codex/api-types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  ConflictDetailResponse,
  ConflictListItem,
  DrydockDetailResponse,
  DrydockListItem,
  DrydockListResponse,
  DrydockMeta,
  EntryFrontmatter,
  EntryResponse,
  SearchEntry,
};

// 하위 호환 별칭 — reading-controller·copy-context-actions 참조
export type WikiEntryResponse = EntryResponse;
export type WikiIndexEntry = SearchEntry;

export interface SearchOptions {
  q?: string;
  tags?: string[];
  limit?: number;
}

export interface EntryOptions {
  includeRaw?: boolean;
}

// ─── Fetchers ─────────────────────────────────────────────────────────────────

export async function fetchSearch(theaterId: string | null, opts?: SearchOptions): Promise<SearchResponse> {
  const params = new URLSearchParams();
  if (opts?.q) params.set("q", opts.q);
  if (opts?.tags && opts.tags.length > 0) params.set("tags", opts.tags.join(","));
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const suffix = params.toString();
  return fetchJson<SearchResponse>(apiPath(theaterId, `/search${suffix ? `?${suffix}` : ""}`));
}

export async function fetchEntry(theaterId: string | null, id: string, opts?: EntryOptions): Promise<EntryResponse> {
  const suffix = opts?.includeRaw ? "?include=raw" : "";
  return fetchJson<EntryResponse>(apiPath(theaterId, `/entry/${encodeURIComponent(id)}${suffix}`));
}

export async function fetchDrydock(theaterId: string | null, status: "pending" | "archived" | "all" = "pending"): Promise<DrydockListResponse> {
  return fetchJson<DrydockListResponse>(apiPath(theaterId, `/drydock?status=${encodeURIComponent(status)}`));
}

export async function fetchDrydockDetail(theaterId: string | null, patchId: string): Promise<DrydockDetailResponse> {
  return fetchJson<DrydockDetailResponse>(apiPath(theaterId, `/drydock/${encodeURIComponent(patchId)}`));
}

export async function decideDrydock(
  theaterId: string | null,
  patchId: string,
  action: "approve" | "reject",
  reason?: string,
): Promise<{ ok: true; meta: DrydockMeta }> {
  const body: Record<string, unknown> = { action };
  if (reason !== undefined) body.reason = reason;
  return postJson<{ ok: true; meta: DrydockMeta }>(
    apiPath(theaterId, `/drydock/${encodeURIComponent(patchId)}/decision`),
    body,
  );
}

export async function fetchConflicts(theaterId: string | null): Promise<ConflictListItem[]> {
  return fetchJson<ConflictListItem[]>(apiPath(theaterId, "/conflicts"));
}

export async function fetchConflictDetail(theaterId: string | null, id: string): Promise<ConflictDetailResponse> {
  return fetchJson<ConflictDetailResponse>(apiPath(theaterId, `/conflicts/${encodeURIComponent(id)}`));
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function apiPath(theaterId: string | null, path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return theaterId
    ? `/console/codex/w/${encodeURIComponent(theaterId)}/api${normalized}`
    : `/console/codex/api${normalized}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(await buildRequestError(url, response));
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await buildRequestError(url, response));
  }
  return response.json() as Promise<T>;
}

async function buildRequestError(url: string, response: Response): Promise<string> {
  const json = await response.json().catch(() => null) as { error?: string } | null;
  return json?.error ?? `${url} request failed: ${response.status}`;
}
