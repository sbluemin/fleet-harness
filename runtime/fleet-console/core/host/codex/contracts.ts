// 서버(routes.ts)와 클라이언트(codex/api.ts)가 공유하는 HTTP 응답 DTO.
// 런타임 코드 없이 타입만 둔다 — 클라이언트 tsconfig이 DOM 전용이므로
// 이 파일에 Node 타입(NodeJS.* 등)을 참조하면 안 된다.

// Cowork DTO의 단일 출처는 fleet-wiki cowork 서브패키지다(type-only라 브라우저 번들 무영향).
export type { CoworkAnnotationDto, CoworkEventDto, CoworkSessionDto } from "@dotobokuri/fleet-wiki/cowork";
/** 콘솔 options 라우트 계약 — 모델 목록은 호스트가 native Claude 별칭 로스터에서 채운다. */
export interface CoworkOptionsResponse { models: readonly string[]; efforts: readonly string[]; defaultModel?: string; defaultEffort?: string; }

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

export interface EntryResponse {
  frontmatter: EntryFrontmatter;
  body: string;
  raw?: RawSourceItem[];
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

export interface DrydockListItem {
  id: string;
  meta: DrydockMeta;
  source: "queue" | "archive";
  summary?: string;
  op?: "create_wiki" | "update_wiki";
  target?: string;
  /** 큐에서 바로 분류할 수 있도록 제안자를 목록에도 싣는다. */
  proposer?: string;
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
  /**
   * 승인 게이트가 diff를 그리려면 제안본만으로는 부족하다 — update_wiki가 덮어쓸 현재
   * 문서 본문을 함께 싣는다. create_wiki이거나 대상이 없으면 null.
   */
  currentBody: string | null;
  /** 현재 문서의 version — 제안본 version과 함께 "v3 → v4"를 그리기 위한 값. */
  currentVersion: number | null;
}

/** 패치 셋 일괄 승인 결과 — fleet-wiki `approvePatchSet`의 전송용 축약형. */
export interface DrydockSetDecisionResponse {
  ok: true;
  patchSetId: string;
  status: "accepted" | "partial";
  acceptedIds: string[];
  failed: Array<{ id: string; error: string }>;
  missing: string[];
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

/**
 * 충돌 화면이 "왜 막혔는지"를 말하려면 meta의 몇 필드가 필수다. 나머지 필드는
 * fleet-wiki ConflictMeta가 계속 넓어지므로 인덱스 시그니처로 열어 둔다.
 */
export interface ConflictDetailMeta {
  status?: string;
  reason?: string;
  createdAt?: string;
  target?: string;
  wikiId?: string;
  title?: string;
  baseVersion?: number;
  currentVersion?: number;
  proposedVersion?: number;
  warnings?: string[];
  resolution?: string;
  resolvedAt?: string;
  note?: string;
  [key: string]: unknown;
}

export interface ConflictDetailResponse {
  id: string;
  meta: ConflictDetailMeta;
  current: string | null;
  proposed: string | null;
  rawSource: string | null;
}

/** 충돌 해결 결과 — `keep_current`는 rejected, `take_proposed`는 queued로 기록된다. */
export interface ConflictResolveResponse {
  ok: true;
  id: string;
  status: string;
  resolution: string;
  resolvedAt?: string;
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
