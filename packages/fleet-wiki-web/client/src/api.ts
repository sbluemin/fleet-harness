export interface HealthResponse {
  ok: boolean;
  version: string;
  cwd: string;
  knowledgeRoot: string;
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
  whyThisMatched?: string;
  enhanced_score?: number;
  graph_boost?: number;
}

export interface ConflictListItem {
  id: string;
  title: string;
  updated: string;
  status: "open" | "resolved" | "unknown";
  path: string;
}

export interface ConflictDetailResponse {
  id: string;
  meta: Record<string, unknown>;
  current: string | null;
  proposed: string | null;
  rawSource: string | null;
}

export interface LogResponse {
  limit: number;
  entries: string[];
  totalEntries: number;
  truncated: boolean;
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
}

export interface QueueListResponse {
  items: QueueListItem[];
  pendingCount: number;
  archivedCount: number;
}

export interface QueuePatchSetMember {
  id: string;
  status?: string;
  target?: string;
  summary?: string;
  source: "queue" | "archive" | "missing";
}

export interface QueuePatchSetResponse {
  id: string;
  sourceRef: string;
  createdAt: string;
  members: QueuePatchSetMember[];
}

export interface PatchDetailResponse {
  source: "queue" | "archive";
  patch: PatchData;
  meta: PatchMetaData;
  wikiEntry: WikiEntryData;
  targetExists: boolean;
  patchSet: QueuePatchSetResponse | null;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>("/api/health");
}

export async function fetchIndex(): Promise<WikiIndexEntry[]> {
  return fetchJson<WikiIndexEntry[]>("/api/index");
}

export async function fetchIndexMarkdown(): Promise<string> {
  return fetchText("/api/index-md");
}

export async function fetchEntry(id: string): Promise<WikiEntryResponse> {
  return fetchJson<WikiEntryResponse>(`/api/entry/${encodeURIComponent(id)}`);
}

export async function fetchSearch(query: string, tags: string[] = [], enhanced = false): Promise<BriefingHit[]> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (tags.length > 0) params.set("tags", tags.join(","));
  if (enhanced) params.set("enhanced", "true");
  const suffix = params.toString();
  return fetchJson<BriefingHit[]>(`/api/search${suffix ? `?${suffix}` : ""}`);
}

export async function fetchRaw(ref: string): Promise<string> {
  return fetchText(`/api/raw?ref=${encodeURIComponent(ref)}`);
}

export async function fetchQueueList(status: "pending" | "archived" | "all"): Promise<QueueListResponse> {
  return fetchJson<QueueListResponse>(`/api/queue?status=${encodeURIComponent(status)}`);
}

export async function fetchPatchDetail(patchId: string): Promise<PatchDetailResponse> {
  return fetchJson<PatchDetailResponse>(`/api/queue/${encodeURIComponent(patchId)}`);
}

export async function approveQueuePatch(patchId: string): Promise<{ ok: true; meta: PatchMetaData }> {
  return postJson<{ ok: true; meta: PatchMetaData }>(`/api/queue/${encodeURIComponent(patchId)}/approve`, {});
}

export async function rejectQueuePatch(patchId: string, reason: string): Promise<{ ok: true; meta: PatchMetaData }> {
  return postJson<{ ok: true; meta: PatchMetaData }>(`/api/queue/${encodeURIComponent(patchId)}/reject`, { reason });
}

export async function fetchConflicts(): Promise<ConflictListItem[]> {
  return fetchJson<ConflictListItem[]>("/api/conflicts");
}

export async function fetchConflictDetail(id: string): Promise<ConflictDetailResponse> {
  return fetchJson<ConflictDetailResponse>(`/api/conflicts/${encodeURIComponent(id)}`);
}

export async function fetchLog(limit?: number): Promise<LogResponse> {
  const suffix = typeof limit === "number" ? `?limit=${encodeURIComponent(String(limit))}` : "";
  return fetchJson<LogResponse>(`/api/log${suffix}`);
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
    const json = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(json?.error ?? `${url} 요청 실패: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function buildRequestError(url: string, response: Response): Promise<string> {
  const json = await response.json().catch(() => null) as { error?: string } | null;
  return json?.error ?? `${url} 요청 실패: ${response.status}`;
}
