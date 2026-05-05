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

export function currentRoute(): Route {
  const route = parseRoute(window.location.pathname);
  // /queue 라우트의 tab은 search params에서 결정
  if (route.name === "queue") {
    const tab = new URLSearchParams(window.location.search).get("tab");
    return { name: "queue", tab: tab === "archived" ? "archived" : "pending" };
  }
  return route;
}

export function navigate(path: string): void {
  if (path === window.location.pathname + window.location.search) return;
  window.history.pushState({}, "", path);
  emit(currentRoute());
}

export function replace(path: string): void {
  window.history.replaceState({}, "", path);
  emit(currentRoute());
}

export function subscribeRoute(listener: RouteListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initRouter(): void {
  window.addEventListener("popstate", () => emit(currentRoute()));
}

export function entryPath(id: string): string {
  return `/entry/${encodeURIComponent(id)}`;
}

export function rawPath(ref: string): string {
  return `/raw/${encodeURIComponent(ref)}`;
}

export function queuePath(tab: "pending" | "archived" = "pending"): string {
  return tab === "archived" ? "/queue?tab=archived" : "/queue";
}

export function queueDetailPath(patchId: string): string {
  return `/queue/${encodeURIComponent(patchId)}`;
}

export function conflictsPath(): string {
  return "/conflicts";
}

export function conflictDetailPath(id: string): string {
  return `/conflicts/${encodeURIComponent(id)}`;
}

export function indexMdPath(): string {
  return "/index";
}

export function logPath(limit?: number): string {
  if (typeof limit !== "number") return "/log";
  return `/log?limit=${encodeURIComponent(String(limit))}`;
}

function parseRoute(pathname: string): Route {
  if (pathname === "/index") {
    return { name: "index-md" };
  }
  if (pathname === "/log") {
    const limit = new URLSearchParams(window.location.search).get("limit");
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
    // tab은 currentRoute()에서 search params로 결정됨
    return { name: "queue", tab: "pending" };
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

function emit(route: Route): void {
  for (const listener of listeners) listener(route);
}
