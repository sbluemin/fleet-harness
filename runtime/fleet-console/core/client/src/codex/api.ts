// 서버 응답 DTO는 src/api-types.ts(타입 전용 파일)를 단일 출처로 공유한다.
// 같은 패키지 서버 코드의 type-only import이므로 Vite 번들에는 포함되지 않는다.
import type {
  ConflictDetailResponse,
  ConflictListItem,
  HealthResponse,
  LogResponse,
  QueuePatchSetMember,
  QueuePatchSetResponse,
  WorkspaceMetadata,
} from "../../../host/codex/api-types";

export type {
  ConflictDetailResponse,
  ConflictListItem,
  HealthResponse,
  LogResponse,
  QueuePatchSetMember,
  QueuePatchSetResponse,
  WorkspaceMetadata,
};

export interface WorkspacesResponse {
  currentWorkspaceId: string | null;
  workspaces: WorkspaceMetadata[];
}

export interface WikiIndexEntry {
  id: string;
  title: string;
  tags: string[];
  updated: string;
  path: string;
  status?: "draft" | "current" | "deprecated" | "superseded";
  revalidateAfter?: string;
  rawSourceRef?: string;
  rawSourceRefs?: string[];
}

export interface WikiEntryFrontmatter {
  id: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  version: number;
  rawSourceRef?: string;
  rawSourceRefs?: string[];
  aliases?: string[];
  status?: "draft" | "current" | "deprecated" | "superseded";
  confidence?: "low" | "medium" | "high";
  type?: string;
  revalidateAfter?: string;
  related?: string[];
  supersedes?: string[];
  whyThisMatched?: string;
}

export interface WikiEntryResponse {
  frontmatter: WikiEntryFrontmatter;
  body: string;
}

export interface BriefingMatchSnippet {
  field: string;
  snippet: string;
}

export interface BriefingHit {
  id: string;
  title: string;
  score: number;
  reason: "id" | "alias" | "tag" | "title" | "body";
  excerpt: string;
  path: string;
  tags: string[];
  updated: string;
  rawSourceRef?: string;
  rawSourceRefs?: string[];
  status?: "draft" | "current" | "deprecated" | "superseded";
  aliases?: string[];
  type?: string;
  matchedFields?: string[];
  matchedSnippets?: BriefingMatchSnippet[];
  whyThisMatched?: string;
  enhanced_score?: number;
  graph_boost?: number;
}

export interface PatchMetaData {
  id: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt?: string;
  reason?: string;
  rawSourceRef?: string;
  warnings?: string[];
  patch_set_id?: string | null;
}

export interface PatchFrontmatterData {
  op: "create_wiki" | "update_wiki";
  target: string;
  summary: string;
  proposer: string;
  created: string;
}

export interface PatchData {
  frontmatter: PatchFrontmatterData;
  body: string;
}

export interface WikiEntryData {
  id: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  version: number;
  rawSourceRef?: string;
  rawSourceRefs?: string[];
  status?: string;
  confidence?: string;
  body: string;
}

export interface QueueListItem {
  id: string;
  meta: PatchMetaData;
  source: "queue" | "archive";
  summary?: string;
  op?: "create_wiki" | "update_wiki";
  target?: string;
}

export interface QueueListResponse {
  items: QueueListItem[];
  pendingCount: number;
  archivedCount: number;
}

export interface PatchDetailResponse {
  source: "queue" | "archive";
  patch: PatchData;
  meta: PatchMetaData;
  wikiEntry: WikiEntryData;
  targetExists: boolean;
  patchSet: QueuePatchSetResponse | null;
}

export async function fetchHealth(theaterId: string | null): Promise<HealthResponse> {
  return fetchJson<HealthResponse>(apiPath(theaterId, "/health"));
}

export async function fetchWorkspaces(theaterId: string | null): Promise<WorkspacesResponse> {
  return fetchJson<WorkspacesResponse>(apiPath(theaterId, "/workspaces"));
}

export async function fetchIndex(theaterId: string | null): Promise<WikiIndexEntry[]> {
  return fetchJson<WikiIndexEntry[]>(apiPath(theaterId, "/index"));
}

export async function fetchIndexMarkdown(theaterId: string | null): Promise<string> {
  return fetchText(apiPath(theaterId, "/index-md"));
}

export async function fetchEntry(theaterId: string | null, id: string): Promise<WikiEntryResponse> {
  return fetchJson<WikiEntryResponse>(apiPath(theaterId, `/entry/${encodeURIComponent(id)}`));
}

export async function fetchSearch(theaterId: string | null, query: string, tags: string[] = [], enhanced = false): Promise<BriefingHit[]> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (tags.length > 0) params.set("tags", tags.join(","));
  if (enhanced) params.set("enhanced", "true");
  const suffix = params.toString();
  return fetchJson<BriefingHit[]>(apiPath(theaterId, `/search${suffix ? `?${suffix}` : ""}`));
}

export async function fetchRaw(theaterId: string | null, ref: string): Promise<string> {
  return fetchText(apiPath(theaterId, `/raw?ref=${encodeURIComponent(ref)}`));
}

export async function fetchQueueList(theaterId: string | null, status: "pending" | "archived" | "all"): Promise<QueueListResponse> {
  return fetchJson<QueueListResponse>(apiPath(theaterId, `/queue?status=${encodeURIComponent(status)}`));
}

export async function fetchPatchDetail(theaterId: string | null, patchId: string): Promise<PatchDetailResponse> {
  return fetchJson<PatchDetailResponse>(apiPath(theaterId, `/queue/${encodeURIComponent(patchId)}`));
}

export async function approveQueuePatch(theaterId: string | null, patchId: string): Promise<{ ok: true; meta: PatchMetaData }> {
  return postJson<{ ok: true; meta: PatchMetaData }>(apiPath(theaterId, `/queue/${encodeURIComponent(patchId)}/approve`), {});
}

export async function rejectQueuePatch(theaterId: string | null, patchId: string, reason: string): Promise<{ ok: true; meta: PatchMetaData }> {
  return postJson<{ ok: true; meta: PatchMetaData }>(apiPath(theaterId, `/queue/${encodeURIComponent(patchId)}/reject`), { reason });
}

export async function fetchConflicts(theaterId: string | null): Promise<ConflictListItem[]> {
  return fetchJson<ConflictListItem[]>(apiPath(theaterId, "/conflicts"));
}

export async function fetchConflictDetail(theaterId: string | null, id: string): Promise<ConflictDetailResponse> {
  return fetchJson<ConflictDetailResponse>(apiPath(theaterId, `/conflicts/${encodeURIComponent(id)}`));
}

export async function fetchLog(theaterId: string | null, limit?: number): Promise<LogResponse> {
  const suffix = typeof limit === "number" ? `?limit=${encodeURIComponent(String(limit))}` : "";
  return fetchJson<LogResponse>(apiPath(theaterId, `/log${suffix}`));
}

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

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: "text/markdown,text/plain" },
  });
  if (!response.ok) {
    throw new Error(await buildRequestError(url, response));
  }
  return response.text();
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
