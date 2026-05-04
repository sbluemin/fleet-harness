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
}

export interface WikiEntryFrontmatter {
  id: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  version: number;
  rawSourceRef?: string;
}

export interface WikiEntryResponse {
  frontmatter: WikiEntryFrontmatter;
  body: string;
}

export interface BriefingHit {
  id: string;
  title: string;
  score: number;
  reason: "id" | "tag" | "title" | "body";
  excerpt: string;
  path: string;
  tags: string[];
  updated: string;
}

export interface BacklinkEntry {
  id: string;
  title: string;
  occurrences: number;
}

export interface BacklinksResponse {
  id: string;
  backlinks: BacklinkEntry[];
}

export interface PatchMetaData {
  id: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt?: string;
  reason?: string;
  rawSourceRef?: string;
  warnings?: string[];
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

export interface PatchDetailResponse {
  source: "queue" | "archive";
  patch: PatchData;
  meta: PatchMetaData;
  wikiEntry: WikiEntryData;
  targetExists: boolean;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>("/api/health");
}

export async function fetchIndex(): Promise<WikiIndexEntry[]> {
  return fetchJson<WikiIndexEntry[]>("/api/index");
}

export async function fetchEntry(id: string): Promise<WikiEntryResponse> {
  return fetchJson<WikiEntryResponse>(`/api/entry/${encodeURIComponent(id)}`);
}

export async function fetchSearch(query: string, tags: string[] = []): Promise<BriefingHit[]> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (tags.length > 0) params.set("tags", tags.join(","));
  const suffix = params.toString();
  return fetchJson<BriefingHit[]>(`/api/search${suffix ? `?${suffix}` : ""}`);
}

export async function fetchBacklinks(id: string): Promise<BacklinksResponse> {
  return fetchJson<BacklinksResponse>(`/api/backlinks/${encodeURIComponent(id)}`);
}

export async function fetchRaw(ref: string): Promise<string> {
  const url = `/api/raw?ref=${encodeURIComponent(ref)}`;
  const response = await fetch(url, { headers: { accept: "text/markdown,text/plain" } });
  if (!response.ok) {
    throw new Error(`${url} 요청 실패: ${response.status}`);
  }
  return response.text();
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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${url} 요청 실패: ${response.status}`);
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
    const json = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(json?.error ?? `${url} 요청 실패: ${response.status}`);
  }
  return response.json() as Promise<T>;
}
