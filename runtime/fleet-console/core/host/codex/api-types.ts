// 서버(routes.ts)와 클라이언트(codex/api.ts)가 공유하는 HTTP 응답 DTO.
// 런타임 코드 없이 타입만 둔다 — 클라이언트 tsconfig이 DOM 전용이므로
// 이 파일에 Node 타입(NodeJS.* 등)을 참조하면 안 된다.

// Cowork DTO의 단일 출처는 fleet-wiki cowork 서브패키지다(type-only라 브라우저 번들 무영향).
export type { CoworkAnnotationDto, CoworkEventDto, CoworkSessionDto, CoworkTranscriptTurnDto } from "@dotobokuri/fleet-wiki/cowork";
/** 콘솔 options 라우트 계약 — CLI/모델 목록은 호스트가 core-unified-agent 레지스트리에서 채운다. */
export interface CoworkOptionsResponse { clis: readonly string[]; models: readonly string[]; efforts: readonly string[]; defaultModel?: string; defaultEffort?: string; }

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
