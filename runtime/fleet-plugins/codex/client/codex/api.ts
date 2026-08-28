// 서버 응답 DTO는 api-types.ts(타입 전용 파일)를 단일 출처로 공유한다.
// 같은 패키지 서버 코드의 type-only import이므로 Vite 번들에는 포함되지 않는다.
import type {
  CoworkAnnotationDto,
  CoworkEventDto,
  CoworkOptionsResponse,
  CoworkSessionDto,
  CodexHealthResponse,
  ConflictDetailResponse,
  ConflictListItem,
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
  CoworkAnnotationDto,
  CoworkEventDto,
  CoworkOptionsResponse,
  CoworkSessionDto,
  CodexHealthResponse,
  ConflictDetailResponse,
  ConflictListItem,
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
export type WikiEntryResponse = EntryResponse;
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

export class CoworkRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "CoworkRequestError";
  }
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

export async function fetchCoworkOptions(theaterId: string | null, model?: string): Promise<CoworkOptionsResponse> {
  // 모델이 없으면 빈 `?`를 남기지 않는다 — 같은 자원에 두 개의 URL이 생긴다.
  const query = model ? `?${new URLSearchParams({ model })}` : "";
  return fetchCoworkJson<CoworkOptionsResponse>(apiPath(theaterId, `/cowork/options${query}`));
}

export interface CoworkAgentSettings { model?: string; effort?: string; }

export async function createCoworkSession(theaterId: string | null, entryId: string, settings?: CoworkAgentSettings): Promise<CoworkSessionDto> {
  return postCoworkJson<CoworkSessionDto>(apiPath(theaterId, "/cowork/sessions"), { entryId, ...settings });
}

/** 엔트리의 활성 세션을 세션 생성 없이 조회한다 — 없으면 null. */
export async function peekCoworkEntrySession(theaterId: string | null, entryId: string): Promise<CoworkSessionDto | null> {
  try {
    return await fetchCoworkJson<CoworkSessionDto>(apiPath(theaterId, `/cowork/entries/${encodeURIComponent(entryId)}/session`));
  } catch (cause) {
    if (cause instanceof CoworkRequestError && cause.status === 404) return null;
    throw cause;
  }
}

export async function updateCoworkSettings(theaterId: string | null, id: string, settings: CoworkAgentSettings): Promise<CoworkSessionDto> {
  return postCoworkJson<CoworkSessionDto>(apiPath(theaterId, `/cowork/sessions/${encodeURIComponent(id)}/settings`), { ...settings });
}

export async function updateCoworkSelection(theaterId: string | null, id: string, selection: string | null): Promise<CoworkSessionDto> {
  return postCoworkJson<CoworkSessionDto>(apiPath(theaterId, `/cowork/sessions/${encodeURIComponent(id)}/selection`), { selection });
}

export async function updateCoworkAnnotations(theaterId: string | null, id: string, annotations: readonly CoworkAnnotationDto[]): Promise<CoworkSessionDto> {
  return postCoworkJson<CoworkSessionDto>(apiPath(theaterId, `/cowork/sessions/${encodeURIComponent(id)}/annotations`), { annotations });
}

export async function promptCowork(theaterId: string | null, id: string, prompt: string): Promise<CoworkSessionDto> {
  return postCoworkJson<CoworkSessionDto>(apiPath(theaterId, `/cowork/sessions/${encodeURIComponent(id)}/prompt`), { prompt });
}

export async function cancelCowork(theaterId: string | null, id: string): Promise<CoworkSessionDto> {
  return postCoworkJson<CoworkSessionDto>(apiPath(theaterId, `/cowork/sessions/${encodeURIComponent(id)}/cancel`), {});
}

export async function applyCowork(theaterId: string | null, id: string, expectedRevision?: number): Promise<CoworkSessionDto> {
  return postCoworkJson<CoworkSessionDto>(apiPath(theaterId, `/cowork/sessions/${encodeURIComponent(id)}/apply`), expectedRevision === undefined ? {} : { expectedRevision });
}

export async function closeCowork(theaterId: string | null, id: string): Promise<CoworkSessionDto> {
  return postCoworkJson<CoworkSessionDto>(apiPath(theaterId, `/cowork/sessions/${encodeURIComponent(id)}/close`), {});
}

export function subscribeCoworkEvents(theaterId: string | null, id: string, after: number, onEvent: (event: CoworkEventDto, eventId: number) => void): () => void {
  const source = new EventSource(`${apiPath(theaterId, `/cowork/sessions/${encodeURIComponent(id)}/events`)}?after=${encodeURIComponent(String(after))}`);
  const receive = (event: MessageEvent<string>) => {
    try {
      const value: unknown = JSON.parse(event.data);
      if (!isCoworkEvent(value)) return;
      onEvent(value, Number(event.lastEventId) || 0);
    } catch { /* malformed server event is ignored */ }
  };
  for (const type of ["session", "transcript", "tool", "done", "error"] as const) source.addEventListener(type, receive);
  return () => source.close();
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

async function fetchCoworkJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw await coworkError(response);
  return response.json() as Promise<T>;
}

async function postCoworkJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw await coworkError(response);
  return response.json() as Promise<T>;
}

async function coworkError(response: Response): Promise<CoworkRequestError> {
  const json = await response.json().catch(() => null) as { error?: unknown } | null;
  return new CoworkRequestError(response.status, typeof json?.error === "string" ? json.error : `cowork_request_failed:${response.status}`);
}

function isCoworkEvent(value: unknown): value is CoworkEventDto {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<CoworkEventDto>;
  return ["session", "transcript", "tool", "done", "error"].includes(event.type ?? "")
    && (event.session === undefined || (event.session !== null && typeof event.session === "object"));
}

async function buildRequestError(url: string, response: Response): Promise<string> {
  const json = await response.json().catch(() => null) as { error?: string } | null;
  return json?.error ?? `${url} request failed: ${response.status}`;
}
