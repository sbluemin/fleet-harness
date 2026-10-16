/** 브라우저가 넘긴 상대 경로를 제품 경로로만 연다. 접두 일치로 쓰기 형제를 열지 않는다. */

export type HostRouteEffect = "read" | "write";
export type HostRouteKind = "json" | "bytes" | "upload" | "events" | "resources" | "socket";

interface HostRoute {
  readonly id: string;
  readonly kind: Exclude<HostRouteKind, "socket">;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly effect: HostRouteEffect;
  readonly conversation?: true;
}

const HOST_ROUTES: readonly HostRoute[] = [
  { id: "theaters", kind: "json", method: "GET", path: "/api/v1/theaters", effect: "read" },
  { id: "operations", kind: "json", method: "GET", path: "/api/v1/operations", effect: "read" },
  { id: "operation-groups", kind: "json", method: "GET", path: "/api/v1/operations/groups", effect: "read" },
  { id: "operation", kind: "json", method: "GET", path: "/api/v1/operations/:operationId", effect: "read" },
  { id: "operation-events", kind: "events", method: "GET", path: "/api/v1/operations/events", effect: "read" },
  { id: "agent-state", kind: "json", method: "GET", path: "/api/v1/agent/state", effect: "read" },
  { id: "agent-sessions", kind: "json", method: "GET", path: "/api/v1/agent/sessions", effect: "read" },
  { id: "agent-history", kind: "json", method: "GET", path: "/api/v1/agent/sessions/:sessionId/chat-history", effect: "read" },
  { id: "agent-job", kind: "json", method: "GET", path: "/api/v1/agent/sessions/:sessionId/chat-job", effect: "read" },
  { id: "agent-catalog", kind: "json", method: "GET", path: "/api/v1/agent/sessions/:sessionId/chat-catalog", effect: "read" },
  { id: "agent-events", kind: "events", method: "GET", path: "/api/v1/agent/events", effect: "read" },
  { id: "agent-message", kind: "json", method: "POST", path: "/api/v1/agent/sessions/:sessionId/message", effect: "write", conversation: true },
  { id: "agent-answer", kind: "json", method: "POST", path: "/api/v1/agent/sessions/:sessionId/chat-answer", effect: "write", conversation: true },
  { id: "agent-stop", kind: "json", method: "POST", path: "/api/v1/agent/sessions/:sessionId/chat-stop", effect: "write", conversation: true },
  // 대화·목표 첨부는 원시 이미지 POST다. 빈 본문과 multipart는 이 목록에 없다. 미리보기 GET은 남긴다.
  { id: "agent-attachment", kind: "upload", method: "POST", path: "/api/v1/agent/attachments", effect: "write" },
  { id: "agent-attachment-discard", kind: "json", method: "DELETE", path: "/api/v1/agent/attachments/:attachmentId", effect: "write" },
  { id: "agent-preview", kind: "resources", method: "GET", path: "/api/v1/agent/attachments/:attachmentId/preview", effect: "read" },
  { id: "files-list", kind: "json", method: "POST", path: "/plugins/file-explorer/files/list", effect: "read" },
  { id: "files-git", kind: "json", method: "POST", path: "/plugins/file-explorer/files/git-status", effect: "read" },
  { id: "files-resolve", kind: "json", method: "POST", path: "/plugins/file-explorer/files/resolve", effect: "read" },
  { id: "files-disk", kind: "json", method: "POST", path: "/plugins/file-explorer/files/disk-status", effect: "read" },
  { id: "files-read", kind: "json", method: "POST", path: "/plugins/file-explorer/files/read", effect: "read" },
  { id: "files-search", kind: "json", method: "POST", path: "/plugins/file-explorer/files/palette-search", effect: "read" },
  { id: "files-image", kind: "resources", method: "GET", path: "/plugins/file-explorer/files/image", effect: "read" },
  { id: "files-watch", kind: "events", method: "GET", path: "/plugins/file-explorer/files/watch", effect: "read" },
  { id: "objectives-state", kind: "json", method: "POST", path: "/plugins/objectives/state", effect: "read" },
  { id: "objectives-finished", kind: "json", method: "POST", path: "/plugins/objectives/finished", effect: "read" },
  { id: "objectives-get", kind: "json", method: "POST", path: "/plugins/objectives/objective/get", effect: "read" },
  { id: "commodore-state", kind: "json", method: "POST", path: "/plugins/objectives/commodore/state", effect: "read" },
  { id: "commodore-transcript", kind: "json", method: "POST", path: "/plugins/objectives/commodore/transcript", effect: "read" },
  { id: "commodore-message", kind: "json", method: "POST", path: "/plugins/objectives/commodore/message", effect: "write", conversation: true },
  { id: "commander-message", kind: "json", method: "POST", path: "/plugins/objectives/commander/message", effect: "write", conversation: true },
  { id: "objective-attachment-add", kind: "upload", method: "POST", path: "/plugins/objectives/attachment/add", effect: "write" },
  { id: "objective-attachment-remove", kind: "json", method: "POST", path: "/plugins/objectives/attachment/remove", effect: "write" },
  { id: "objective-attachment", kind: "resources", method: "GET", path: "/plugins/objectives/attachment/file", effect: "read" },
  { id: "objective-evidence", kind: "resources", method: "GET", path: "/plugins/objectives/result/file", effect: "read" },
  { id: "objective-create", kind: "json", method: "POST", path: "/plugins/objectives/objective/create", effect: "write" },
  { id: "objective-patch", kind: "json", method: "POST", path: "/plugins/objectives/objective/patch", effect: "write" },
  { id: "objective-move", kind: "json", method: "POST", path: "/plugins/objectives/objective/move", effect: "write" },
  { id: "objective-operator", kind: "json", method: "POST", path: "/plugins/objectives/objective/operator", effect: "write" },
  { id: "objective-restore", kind: "json", method: "POST", path: "/plugins/objectives/objective/restore", effect: "write" },
  { id: "objective-archive", kind: "json", method: "POST", path: "/plugins/objectives/objective/archive", effect: "write" },
  { id: "objective-remove", kind: "json", method: "POST", path: "/plugins/objectives/objective/remove", effect: "write" },
  { id: "objective-complete", kind: "json", method: "POST", path: "/plugins/objectives/objective/complete", effect: "write" },
  { id: "objective-extend", kind: "json", method: "POST", path: "/plugins/objectives/objective/extend", effect: "write" },
  { id: "objective-hand-off", kind: "json", method: "POST", path: "/plugins/objectives/objective/hand-off", effect: "write" },
  { id: "person-hold-return", kind: "json", method: "POST", path: "/plugins/objectives/person-hold/return", effect: "write" },
  { id: "followup-discard", kind: "json", method: "POST", path: "/plugins/objectives/followup/discard", effect: "write" },
  { id: "followup-retry", kind: "json", method: "POST", path: "/plugins/objectives/followup/retry", effect: "write" },
  { id: "followup-abandon", kind: "json", method: "POST", path: "/plugins/objectives/followup/abandon", effect: "write" },
  { id: "member-add", kind: "json", method: "POST", path: "/plugins/objectives/member/add", effect: "write" },
  { id: "member-patch", kind: "json", method: "POST", path: "/plugins/objectives/member/patch", effect: "write" },
  { id: "member-next-cancel", kind: "json", method: "POST", path: "/plugins/objectives/member/next-cancel", effect: "write" },
  { id: "member-batch-launch", kind: "json", method: "POST", path: "/plugins/objectives/member/batch-launch", effect: "write" },
  { id: "member-remove", kind: "json", method: "POST", path: "/plugins/objectives/member/remove", effect: "write" },
  { id: "routing-preview", kind: "json", method: "POST", path: "/plugins/objectives/routing/preview", effect: "write" },
  { id: "mission-add", kind: "json", method: "POST", path: "/plugins/objectives/mission/add", effect: "write" },
  { id: "mission-patch", kind: "json", method: "POST", path: "/plugins/objectives/mission/patch", effect: "write" },
  { id: "mission-seen", kind: "json", method: "POST", path: "/plugins/objectives/mission/seen", effect: "write" },
  { id: "mission-remove", kind: "json", method: "POST", path: "/plugins/objectives/mission/remove", effect: "write" },
  { id: "edge-toggle", kind: "json", method: "POST", path: "/plugins/objectives/edge/toggle", effect: "write" },
  { id: "plan-request", kind: "json", method: "POST", path: "/plugins/objectives/plan/request", effect: "write" },
  { id: "commander-compact", kind: "json", method: "POST", path: "/plugins/objectives/commander/compact", effect: "write" },
  { id: "commander-stop", kind: "json", method: "POST", path: "/plugins/objectives/commander/stop", effect: "write" },
  { id: "commander-start", kind: "json", method: "POST", path: "/plugins/objectives/commander/start", effect: "write" },
  { id: "commander-steer", kind: "json", method: "POST", path: "/plugins/objectives/commander/steer", effect: "write" },
  { id: "decision-answer", kind: "json", method: "POST", path: "/plugins/objectives/decision/answer", effect: "write" },
  { id: "commodore-ask-answer", kind: "json", method: "POST", path: "/plugins/objectives/commodore/ask/answer", effect: "write" },
  { id: "conversation-broadcast", kind: "json", method: "POST", path: "/plugins/objectives/conversation/broadcast", effect: "write" },
  { id: "criterion-add", kind: "json", method: "POST", path: "/plugins/objectives/criterion/add", effect: "write" },
  { id: "criterion-patch", kind: "json", method: "POST", path: "/plugins/objectives/criterion/patch", effect: "write" },
  { id: "criterion-remove", kind: "json", method: "POST", path: "/plugins/objectives/criterion/remove", effect: "write" },
  { id: "criterion-approve", kind: "json", method: "POST", path: "/plugins/objectives/criterion/approve", effect: "write" },
  { id: "criterion-approve-all", kind: "json", method: "POST", path: "/plugins/objectives/criterion/approve-all", effect: "write" },
  { id: "criterion-reject", kind: "json", method: "POST", path: "/plugins/objectives/criterion/reject", effect: "write" },
  { id: "criterion-annotate", kind: "json", method: "POST", path: "/plugins/objectives/criterion/annotate", effect: "write" },
  { id: "palette-search", kind: "json", method: "POST", path: "/plugins/objectives/palette-search", effect: "read" },
  { id: "quota-summary", kind: "json", method: "GET", path: "/plugins/quota/summary", effect: "read" },
];

export interface AdmittedHostRoute {
  readonly id: string;
  readonly method: "GET" | "HEAD" | "POST" | "DELETE";
  readonly path: string;
}

export function admitHostRoute(input: {
  readonly kind: HostRouteKind;
  readonly method?: string;
  readonly path?: string;
  readonly mode: "observer" | "controller";
}): AdmittedHostRoute | { readonly error: "route_denied" | "read_only" | "not_controller" } {
  if (input.kind === "socket") return input.mode === "controller" ? { id: "terminal-ws", method: "GET", path: "/api/v1/terminal/ws" } : { error: "not_controller" };
  const pathname = input.path?.split("?")[0] ?? "";
  const method = input.method === "HEAD" ? "GET" : input.method;
  const route = HOST_ROUTES.find((entry) => entry.kind === input.kind && entry.method === method && pathMatches(entry.path, pathname));
  if (!route || input.path === undefined) return { error: "route_denied" };
  if (input.mode === "observer" && route.conversation) return { error: "not_controller" };
  if (input.mode === "observer" && route.effect === "write") return { error: "read_only" };
  return { id: route.id, method: input.method === "HEAD" ? "HEAD" : route.method, path: input.path };
}

export function hostRoutePath(routeId: string): string | null {
  if (routeId === "terminal-ws") return "/api/v1/terminal/ws";
  return HOST_ROUTES.find((entry) => entry.id === routeId)?.path ?? null;
}

function pathMatches(pattern: string, pathname: string): boolean {
  const left = pattern.split("/");
  const right = pathname.split("/");
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const actual = right[index] ?? "";
    return segment.startsWith(":") ? actual.length > 0 : segment === actual;
  });
}
