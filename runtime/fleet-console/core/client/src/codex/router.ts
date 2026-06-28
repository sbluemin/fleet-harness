import { getState } from "./state";

// patchId 클라이언트 측 검증 — 서버 SAFE_PATCH_ID와 동일
const SAFE_PATCH_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z-[0-9a-f]{8}$/;

export type Route =
  | { name: "home" }
  | { name: "entry"; id: string }
  | { name: "raw"; ref: string }
  | { name: "queue"; tab: "pending" | "archived" }
  | { name: "queue-detail"; patchId: string }
  | { name: "conflicts" }
  | { name: "conflict-detail"; id: string }
  | { name: "index-md" }
  | { name: "log"; limit: number };

type RouteListener = (route: Route) => void;

const listeners = new Set<RouteListener>();
let activeRoute: Route = { name: "home" };

export function currentRoute(): Route {
  return activeRoute;
}

export function navigate(path: string): void {
  const route = parsePath(path);
  if (routeKey(activeRoute) === routeKey(route)) return;
  activeRoute = route;
  emit(activeRoute);
}

export function replace(path: string): void {
  activeRoute = parsePath(path);
  emit(activeRoute);
}

export function subscribeRoute(listener: RouteListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initRouter(): void {
  activeRoute = { name: "home" };
}

export function destroyRouter(): void {
  activeRoute = { name: "home" };
  listeners.clear();
}

export function entryPath(id: string): string {
  return withWorkspace(`/entry/${encodeURIComponent(id)}`);
}

export function rawPath(ref: string): string {
  return withWorkspace(`/raw/${encodeURIComponent(ref)}`);
}

export function queuePath(tab: "pending" | "archived" = "pending"): string {
  return withWorkspace(tab === "archived" ? "/queue?tab=archived" : "/queue");
}

export function queueDetailPath(patchId: string): string {
  return withWorkspace(`/queue/${encodeURIComponent(patchId)}`);
}

export function conflictsPath(): string {
  return withWorkspace("/conflicts");
}

export function conflictDetailPath(id: string): string {
  return withWorkspace(`/conflicts/${encodeURIComponent(id)}`);
}

export function indexMdPath(): string {
  return withWorkspace("/index-md");
}

export function logPath(limit?: number): string {
  if (typeof limit !== "number") return withWorkspace("/log");
  return withWorkspace(`/log?limit=${encodeURIComponent(String(limit))}`);
}

export function homePath(): string {
  return withWorkspace("/");
}

function parsePath(rawPath: string): Route {
  const url = new URL(rawPath, "http://x");
  let { pathname } = url;
  // /console/codex 접두사 제거 — Full route URL 호환성(W3 라우트 제거 전 단계)
  const codexBase = "/console/codex";
  if (pathname === codexBase || pathname === `${codexBase}/`) {
    pathname = "/";
  } else if (pathname.startsWith(`${codexBase}/`)) {
    pathname = pathname.slice(codexBase.length);
  }
  const { pathname: innerPath } = stripWorkspacePrefix(pathname);
  return parseRoute(innerPath, url.searchParams);
}

function parseRoute(pathname: string, searchParams: URLSearchParams): Route {
  if (pathname === "/index" || pathname === "/index-md") {
    return { name: "index-md" };
  }
  if (pathname === "/log") {
    const limit = searchParams.get("limit");
    const parsed = Number(limit ?? 20);
    return { name: "log", limit: Number.isInteger(parsed) ? parsed : 20 };
  }
  if (pathname === "/conflicts") {
    return { name: "conflicts" };
  }
  const conflictDetailMatch = pathname.match(/^\/conflicts\/([^/]+)$/);
  if (conflictDetailMatch) {
    return { name: "conflict-detail", id: decodeURIComponent(conflictDetailMatch[1] ?? "") };
  }
  const entryMatch = pathname.match(/^\/entry\/([^/]+)$/);
  if (entryMatch) {
    return { name: "entry", id: decodeURIComponent(entryMatch[1] ?? "") };
  }
  const rawMatch = pathname.match(/^\/raw\/(.+)$/);
  if (rawMatch) {
    return { name: "raw", ref: decodeURIComponent(rawMatch[1] ?? "") };
  }
  if (pathname === "/queue") {
    const tab = searchParams.get("tab");
    return { name: "queue", tab: tab === "archived" ? "archived" : "pending" };
  }
  const queueDetailMatch = pathname.match(/^\/queue\/([^/]+)$/);
  if (queueDetailMatch) {
    const patchId = decodeURIComponent(queueDetailMatch[1] ?? "");
    if (SAFE_PATCH_ID.test(patchId)) {
      return { name: "queue-detail", patchId };
    }
    return { name: "home" };
  }
  return { name: "home" };
}

function withWorkspace(path: string): string {
  const wsId = getState().currentWorkspaceId;
  return wsId ? `/w/${encodeURIComponent(wsId)}${path}` : path;
}

function stripWorkspacePrefix(pathname: string): { pathname: string; wsId: string | null } {
  const prefix = workspacePrefix(pathname);
  return prefix ? { pathname: prefix.pathname, wsId: prefix.wsId } : { pathname, wsId: null };
}

function workspacePrefix(pathname: string): { wsId: string; pathname: string } | null {
  const match = pathname.match(/^\/w\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return {
    wsId: decodeURIComponent(match[1] ?? ""),
    pathname: match[2] ?? "/",
  };
}

function routeKey(route: Route): string {
  if (route.name === "entry") return `entry:${route.id}`;
  if (route.name === "raw") return `raw:${route.ref}`;
  if (route.name === "queue") return `queue:${route.tab}`;
  if (route.name === "queue-detail") return `queue-detail:${route.patchId}`;
  if (route.name === "conflict-detail") return `conflict-detail:${route.id}`;
  if (route.name === "log") return `log:${route.limit}`;
  return route.name;
}

function emit(route: Route): void {
  for (const listener of listeners) listener(route);
}
