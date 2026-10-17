// 서버 응답 DTO는 api-types.ts(타입 전용 파일)를 단일 출처로 공유한다.
// 같은 패키지 서버 코드의 type-only import이므로 Vite 번들에는 포함되지 않는다.
import type {
  CodexHealthResponse,
  ConflictDetailResponse,
  ConflictListItem,
  DrydockBaseConflict,
  DrydockBatchResponse,
  DrydockDetailResponse,
  DrydockDiffStat,
  DrydockListItem,
  DrydockListResponse,
  DrydockMeta,
  EntryBacklink,
  EntryFrontmatter,
  EntryResponse,
  SearchEntry,
  SearchResponse,
  SchemaCatalogResponse,
  SchemaDocumentResponse,
} from "../../server/codex/contracts.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  CodexHealthResponse,
  ConflictDetailResponse,
  ConflictListItem,
  DrydockBaseConflict,
  DrydockBatchResponse,
  DrydockDetailResponse,
  DrydockDiffStat,
  DrydockListItem,
  DrydockListResponse,
  DrydockMeta,
  EntryBacklink,
  EntryFrontmatter,
  EntryResponse,
  SearchEntry,
  SchemaCatalogResponse,
  SchemaDocumentResponse,
};

// 하위 호환 별칭 — navigator 참조
export type WikiIndexEntry = SearchEntry;

export interface SearchOptions {
  q?: string;
  tags?: string[];
  limit?: number;
  signal?: AbortSignal;
}

export interface EntryOptions {
  includeRaw?: boolean;
}

export class CodexRequestError extends Error {
  constructor(readonly status: number, readonly code: string, readonly baseConflict?: DrydockBaseConflict) {
    super(code);
    this.name = "CodexRequestError";
  }
}


export async function fetchFilePeek(theaterId: string, path: string, line?: number): Promise<import("../../server/codex/contracts.js").FilePeekResponse> {
  return postJson("/api/v1/plugins/codex/file-peek", { theaterId, path, line });
}

export async function fetchFileRefs(theaterId: string, paths: readonly string[]): Promise<readonly import("../../server/codex/contracts.js").FileRefResolution[]> {
  return postJson("/api/v1/plugins/codex/file-refs", { theaterId, paths });
}

// ─── Fetchers ─────────────────────────────────────────────────────────────────

export async function fetchSearch(theaterId: string | null, opts?: SearchOptions): Promise<SearchResponse> {
  const params = new URLSearchParams();
  if (opts?.q) params.set("q", opts.q);
  if (opts?.tags && opts.tags.length > 0) params.set("tags", opts.tags.join(","));
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const suffix = params.toString();
  return fetchJson<SearchResponse>(apiPath(theaterId, `/search${suffix ? `?${suffix}` : ""}`), opts?.signal);
}

export async function fetchEntry(theaterId: string | null, id: string, opts?: EntryOptions): Promise<EntryResponse> {
  const suffix = opts?.includeRaw ? "?include=raw" : "";
  return fetchJson<EntryResponse>(apiPath(theaterId, `/entry/${encodeURIComponent(id)}${suffix}`));
}

export async function fetchHealth(theaterId: string | null, signal?: AbortSignal): Promise<CodexHealthResponse> {
  return fetchJson<CodexHealthResponse>(apiPath(theaterId, "/health"), signal);
}

export async function fetchDrydock(theaterId: string | null, status: "pending" | "archived" | "all" = "pending"): Promise<DrydockListResponse> {
  return fetchJson<DrydockListResponse>(apiPath(theaterId, `/drydock?status=${encodeURIComponent(status)}`));
}

export async function fetchDrydockDetail(theaterId: string | null, patchId: string): Promise<DrydockDetailResponse> {
  return fetchJson<DrydockDetailResponse>(apiPath(theaterId, `/drydock/${encodeURIComponent(patchId)}`));
}

export async function fetchSchemaCatalog(theaterId: string | null): Promise<SchemaCatalogResponse> {
  return fetchJson<SchemaCatalogResponse>(apiPath(theaterId, "/schema"));
}

export async function fetchSchemaDocument(theaterId: string | null, templateId?: string): Promise<SchemaDocumentResponse> {
  const path = templateId ? `/schema/templates/${encodeURIComponent(templateId)}` : "/schema/wiki-schema";
  return fetchJson<SchemaDocumentResponse>(apiPath(theaterId, path));
}

export async function stageEntryDeletion(theaterId: string | null, id: string): Promise<{ ok: true; patchId: string }> {
  return postJson<{ ok: true; patchId: string }>(apiPath(theaterId, `/entry/${encodeURIComponent(id)}/stage-delete`), {});
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

export async function decideDrydockBatch(theaterId: string | null, patchIds: readonly string[], action: "approve" | "reject", reason?: string): Promise<DrydockBatchResponse> {
  return postJson(apiPath(theaterId, "/drydock/batch-decision"), { patchIds, action, reason });
}

export async function fetchConflicts(theaterId: string | null): Promise<ConflictListItem[]> {
  return fetchJson<ConflictListItem[]>(apiPath(theaterId, "/conflicts"));
}

export async function fetchConflictDetail(theaterId: string | null, id: string): Promise<ConflictDetailResponse> {
  return fetchJson<ConflictDetailResponse>(apiPath(theaterId, `/conflicts/${encodeURIComponent(id)}`));
}

export async function decideConflict(theaterId: string | null, id: string, action: "reject" | "repropose" | "resolve", note: string, expectedCurrentHash?: string): Promise<{ ok: true; patchId?: string }> {
  return postJson(apiPath(theaterId, `/conflicts/${encodeURIComponent(id)}/decision`), { action, note, expectedCurrentHash });
}


// ─── Internal helpers ─────────────────────────────────────────────────────────

function apiPath(theaterId: string | null, path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return theaterId
    ? `/console/codex/w/${encodeURIComponent(theaterId)}/api${normalized}`
    : `/console/codex/api${normalized}`;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw await buildRequestError(url, response);
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
    throw await buildRequestError(url, response);
  }
  return response.json() as Promise<T>;
}

async function buildRequestError(url: string, response: Response): Promise<CodexRequestError> {
  const json = await response.json().catch(() => null) as { error?: string; baseConflict?: DrydockBaseConflict } | null;
  return new CodexRequestError(response.status, json?.error ?? `${url} request failed: ${response.status}`, json?.baseConflict);
}
