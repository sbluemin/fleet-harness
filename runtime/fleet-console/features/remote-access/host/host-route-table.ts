/** 브라우저가 넘긴 상대 경로를 제품 경로로만 연다. 접두 일치로 쓰기 형제를 열지 않는다. */

export type HostRouteEffect = "read" | "write";
export type HostRouteKind = "json" | "bytes" | "events" | "resources" | "socket";

interface HostRoute {
  readonly id: string;
  readonly kind: Exclude<HostRouteKind, "socket">;
  readonly method: "GET" | "POST";
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
  // 원격 이진 업로드는 지원하지 않는다. 빈 POST도 셸로 보내지 않고 route_denied다. 미리보기 GET은 남긴다.
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
  { id: "objective-attachment", kind: "resources", method: "GET", path: "/plugins/objectives/attachment/file", effect: "read" },
  { id: "objective-evidence", kind: "resources", method: "GET", path: "/plugins/objectives/result/file", effect: "read" },
  { id: "quota-summary", kind: "json", method: "GET", path: "/plugins/quota/summary", effect: "read" },
];

export interface AdmittedHostRoute {
  readonly id: string;
  readonly method: "GET" | "HEAD" | "POST";
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
