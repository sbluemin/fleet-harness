export type Route =
  | { name: "home" }
  | { name: "entry"; id: string }
  | { name: "raw"; ref: string };

type RouteListener = (route: Route) => void;

const listeners = new Set<RouteListener>();

export function currentRoute(): Route {
  return parseRoute(window.location.pathname);
}

export function navigate(path: string): void {
  if (path === window.location.pathname) return;
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

function parseRoute(pathname: string): Route {
  const entryMatch = pathname.match(/^\/entry\/([^/]+)$/);
  if (entryMatch) {
    return { name: "entry", id: decodeURIComponent(entryMatch[1] ?? "") };
  }
  const rawMatch = pathname.match(/^\/raw\/(.+)$/);
  if (rawMatch) {
    return { name: "raw", ref: decodeURIComponent(rawMatch[1] ?? "") };
  }
  return { name: "home" };
}

function emit(route: Route): void {
  for (const listener of listeners) listener(route);
}
