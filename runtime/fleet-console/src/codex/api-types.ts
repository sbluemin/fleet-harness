// 서버(src/routes.ts, src/workspaces.ts)와 클라이언트(client/src/api.ts)가 공유하는
// HTTP 응답 DTO 정의. 런타임 코드 없이 타입만 둔다 — 클라이언트 tsconfig가 DOM 전용이므로
// 이 파일에 Node 타입(NodeJS.* 등)을 참조하면 안 된다.

export interface HealthResponse {
  ok: boolean;
  version: string;
  // external mode에서는 서버가 cwd/knowledgeRoot를 redact하므로 optional이다.
  cwd?: string;
  knowledgeRoot?: string;
}

export interface WorkspaceMetadata {
  id: string;
  cwd: string;
  label: string;
  registeredAt: string;
  lastOpenedAt: string;
  urlPath: string;
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
