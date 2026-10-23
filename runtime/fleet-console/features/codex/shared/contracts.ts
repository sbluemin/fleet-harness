// 서버(routes.ts)와 클라이언트(codex/api.ts)가 공유하는 HTTP 응답 DTO.
// 런타임 코드 없이 타입만 둔다 — 클라이언트 tsconfig이 DOM 전용이므로
// 이 파일에 Node 타입(NodeJS.* 등)을 참조하면 안 된다.

export interface FilePeekResponse {
  readonly path: string;
  readonly language: string;
  readonly startLine: number;
  readonly lines: readonly string[];
  readonly truncated: boolean;
}
export type FileRefStatus = "file" | "dir" | "missing" | "unavailable";
/** 요청 순서에 대응한다. unavailable은 경로와 존재 여부를 반사하지 않는다. */
export type FileRefResolution =
  | { readonly path: ""; readonly status: "unavailable" }
  | { readonly path: string; readonly status: Exclude<FileRefStatus, "unavailable"> };

export interface SearchEntry {
  id: string;
  title: string;
  tags: string[];
  updated: string;
  path: string;
  status?: "draft" | "current" | "deprecated" | "superseded";
  revalidateAfter?: string;
  rawSourceRef?: string;
  rawSourceRefs?: string[];
  // briefingQuery 결과 시 추가 필드
  score?: number;
  excerpt?: string;
  reason?: "id" | "alias" | "tag" | "title" | "body";
  aliases?: string[];
  type?: string;
  matchedFields?: string[];
  whyThisMatched?: string;
}

export interface SearchResponse {
  entries: SearchEntry[];
  total: number;
}

export interface RawSourceItem {
  ref: string;
  content: string;
}

export interface EntryFrontmatter {
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

export interface EntryBacklink {
  id: string;
  title: string;
  updated: string;
}

export interface EntryResponse {
  frontmatter: EntryFrontmatter;
  body: string;
  raw?: RawSourceItem[];
  /** 본문에서 [[wiki:이 문서]]를 참조하는 다른 엔트리들(역링크). */
  backlinks?: EntryBacklink[];
  hash: string;
}

export interface EntryDeleteResponse { ok: true; historyRef: string; }
export interface EntryRestoreResponse { ok: true; version: number; }

export interface SchemaCatalogResponse {
  schema: { ref: string; exists: boolean; summary: string };
  templates: Array<{ id: string; ref: string; sections: string[] }>;
}

export interface SchemaDocumentResponse {
  ref: string;
  content: string;
}

export interface CodexHealthResponse {
  lastDrydock: {
    at: string;
    ok: boolean;
    errorCount: number;
    warningCount: number;
    infoCount: number;
    issueCount: number;
  } | null;
  logUnreadable?: true;
}

/** Operation SSE 채널 위의 Codex 이벤트 이름 — 클라이언트 리스너와 한 글자도 달라선 안 된다. */
export const CODEX_CHANGED_EVENT = "codex:changed";
export const CODEX_WATCH_EVENT = "codex:watch";

/**
 * Codex 지식 루트에서 변한 범위. 이벤트는 사실을 싣지 않고 "여기가 변했다"만 말한다 —
 * 화면은 그 힌트를 받아 정식 API로 다시 읽는다(순서 뒤바뀜·유실에 강하다).
 */
export type CodexKnowledgeScope = "wiki" | "schema" | "index" | "health";

/** 감시가 살아 있는지. degraded면 화면은 스스로 주기 재검증으로 강등한다. */
export type CodexWatchState = "watching" | "degraded";

export interface CodexChangedEvent {
  readonly workspaceId: string;
  readonly scopes: readonly CodexKnowledgeScope[];
}

export interface CodexWatchEvent {
  readonly workspaceId: string;
  readonly state: CodexWatchState;
}

export interface AllowedAccessSets {
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  externalMode: boolean;
}

export const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export function withSecurityHeaders(headers?: Record<string, string>): Record<string, string> {
  return {
    ...SECURITY_HEADERS,
    ...(headers ?? {}),
  };
}

export function encodeSseData(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
