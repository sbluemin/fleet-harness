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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${url} 요청 실패: ${response.status}`);
  }
  return response.json() as Promise<T>;
}
