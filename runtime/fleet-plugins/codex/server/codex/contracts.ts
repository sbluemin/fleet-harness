// 서버(routes.ts)와 클라이언트(codex/api.ts)가 공유하는 HTTP 응답 DTO.
// 런타임 코드 없이 타입만 둔다 — 클라이언트 tsconfig이 DOM 전용이므로
// 이 파일에 Node 타입(NodeJS.* 등)을 참조하면 안 된다.

// Cowork DTO의 단일 출처는 fleet-wiki cowork 서브패키지다(type-only라 브라우저 번들 무영향).
export type { CoworkAnnotationDto, CoworkEventDto, CoworkSessionDto } from "@dotobokuri/fleet-wiki/cowork";
/** Cowork 모델 한 행 — id는 Gateway가 받는 모델 표기, label은 메뉴에 보이는 이름, provider는 공급자 밴드다. */
export interface CoworkModelRow { readonly id: string; readonly label: string; readonly provider: string; }
/** 콘솔 options 라우트 계약 — 모델 목록은 호스트가 큐레이션한 Claude 별칭 + Gateway 모델이다. */
export interface CoworkOptionsResponse { models: readonly string[]; efforts: readonly string[]; defaultModel?: string; defaultEffort?: string; rows?: readonly CoworkModelRow[]; }

// workspaces.ts 내부용 — /api/workspaces endpoint는 폐기됨, 타입만 유지
export interface WorkspaceMetadata {
  id: string;
  cwd: string;
  label: string;
  registeredAt: string;
  lastOpenedAt: string;
  urlPath: string;
}

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
}

export interface DrydockPatchSetMember {
  id: string;
  status?: string;
  target?: string;
  summary?: string;
  source: "queue" | "archive" | "missing";
}

export interface DrydockPatchSetResponse {
  id: string;
  sourceRef: string;
  createdAt: string;
  members: DrydockPatchSetMember[];
}

export interface DrydockMeta {
  id: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt?: string;
  reason?: string;
  rawSourceRef?: string;
  warnings?: string[];
  patch_set_id?: string | null;
}

export interface DrydockDiffStat {
  /** 제안이 더하는 라인 수(변경 블록 기준). */
  added: number;
  /** 제안이 걷어내는 라인 수(변경 블록 기준). */
  removed: number;
}

export interface DrydockListItem {
  id: string;
  meta: DrydockMeta;
  source: "queue" | "archive";
  summary?: string;
  op?: "create_wiki" | "update_wiki";
  target?: string;
  proposer?: string;
  /** pending(queue) 항목에만 계산된다 — 결정된 패치의 diff는 현재 문서와 무의미하다. */
  diffstat?: DrydockDiffStat;
}

export interface DrydockListResponse {
  items: DrydockListItem[];
  pendingCount: number;
  archivedCount: number;
}

export interface DrydockPatchFrontmatter {
  op: "create_wiki" | "update_wiki";
  target: string;
  summary: string;
  proposer: string;
  created: string;
}

export interface DrydockPatch {
  frontmatter: DrydockPatchFrontmatter;
  body: string;
}

export interface DrydockWikiEntry {
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

export interface DrydockDetailResponse {
  source: "queue" | "archive";
  patch: DrydockPatch;
  meta: DrydockMeta;
  wikiEntry: DrydockWikiEntry;
  targetExists: boolean;
  patchSet: DrydockPatchSetResponse | null;
}

export interface SchemaCatalogResponse {
  schema: { ref: string; exists: boolean; summary: string };
  templates: Array<{ id: string; ref: string; sections: string[] }>;
}

export interface SchemaDocumentResponse {
  ref: string;
  content: string;
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

export interface CodexHealthResponse {
  lastDrydock: {
    at: string;
    ok: boolean;
    errorCount: number;
    warningCount: number;
    infoCount: number;
    issueCount: number;
  } | null;
  conflictCount: number;
  pendingCount: number;
  logUnreadable?: true;
}

/** Operation SSE 채널 위의 Codex 이벤트 이름 — 클라이언트 리스너와 한 글자도 달라선 안 된다. */
export const CODEX_CHANGED_EVENT = "codex:changed";
export const CODEX_WATCH_EVENT = "codex:watch";

/**
 * Codex 지식 루트에서 변한 범위. 이벤트는 사실을 싣지 않고 "여기가 변했다"만 말한다 —
 * 화면은 그 힌트를 받아 정식 API로 다시 읽는다(순서 뒤바뀜·유실에 강하다).
 */
export type CodexKnowledgeScope = "queue" | "wiki" | "conflicts" | "schema" | "index";

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
