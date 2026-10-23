// 서버 응답 DTO는 api-types.ts(타입 전용 파일)를 단일 출처로 공유한다.
// 같은 패키지 서버 코드의 type-only import이므로 Vite 번들에는 포함되지 않는다.
import type {
  CodexHealthResponse,
  EntryBacklink,
  EntryFrontmatter,
  EntryResponse,
  EntryDeleteResponse,
  EntryRestoreResponse,
  SearchEntry,
  SearchResponse,
  SchemaCatalogResponse,
  SchemaDocumentResponse,
} from "../../server/codex/contracts.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  CodexHealthResponse,
  EntryBacklink,
  EntryFrontmatter,
  EntryResponse,
  EntryDeleteResponse,
  EntryRestoreResponse,
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
  constructor(readonly status: number, readonly code: string) {
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

export async function fetchSchemaCatalog(theaterId: string | null): Promise<SchemaCatalogResponse> {
  return fetchJson<SchemaCatalogResponse>(apiPath(theaterId, "/schema"));
}

export async function fetchSchemaDocument(theaterId: string | null, templateId?: string): Promise<SchemaDocumentResponse> {
  const path = templateId ? `/schema/templates/${encodeURIComponent(templateId)}` : "/schema/wiki-schema";
  return fetchJson<SchemaDocumentResponse>(apiPath(theaterId, path));
}

export async function deleteEntry(theaterId: string | null, id: string, expectedHash: string): Promise<EntryDeleteResponse> {
  return postJson(apiPath(theaterId, `/entry/${encodeURIComponent(id)}/delete`), { expectedHash });
}

export async function restoreEntry(theaterId: string | null, id: string, historyRef: string): Promise<EntryRestoreResponse> {
  return postJson(apiPath(theaterId, `/entry/${encodeURIComponent(id)}/restore`), { historyRef });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function apiPath(theaterId: string | null, path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return theaterId
    ? `/console/codex/c/${encodeURIComponent(theaterId)}/api${normalized}`
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
  const json = await response.json().catch(() => null) as { error?: string } | null;
  return new CodexRequestError(response.status, json?.error ?? `${url} request failed: ${response.status}`);
}
