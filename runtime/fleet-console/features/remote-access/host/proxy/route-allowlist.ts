/**
 * epoch 리스너가 받아 주는 요청의 전부. 이 표에 없으면 404다 — SPA가 부르는 쓰기·WS·로컬 control-plane·
 * 플러그인 경로는 여기 없으므로 데이터 뷰에서 로컬에 닿을 길이 구조적으로 없다. 확대는 수기 보안 검토를 거친다.
 *
 * 경로는 한 번만 판정한다: 퍼센트 인코딩·백슬래시·빈/점 세그먼트·절대 URL·중복 쿼리 키는 풀어 보지 않고 거부한다.
 */
export type EpochRoute =
  | { readonly kind: "static"; readonly relative: string }
  | { readonly kind: "synthetic"; readonly id: "status" | "settings" | "manifest" | "proxy-state" | "join" }
  | { readonly kind: "upstream"; readonly transport: "http" | "sse"; readonly path: string; readonly events?: readonly string[] };

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SAFE_PATH = /^\/[A-Za-z0-9._~/-]*$/u;
const SAFE_QUERY = /^[A-Za-z0-9._~=&-]*$/u;
const ASSET = /^assets\/[A-Za-z0-9._-]+$/u;
const SPA_ROUTE = /^[A-Za-z0-9/-]*$/u;

/** 데이터 뷰로 흘려도 되는 원격 이벤트. control:*·desktop:*·update:*·플러그인 채널은 없다. */
export const OPERATIONS_STREAM_EVENTS = ["operation:changed", "operation:removed", "operation:cluster-changed", "group:changed", "group:removed"] as const;
export const AGENT_STREAM_EVENTS = ["session:updated", "session:attention"] as const;

export type RouteDecision = { readonly ok: true; readonly route: EpochRoute } | { readonly ok: false; readonly status: 400 | 404 };

export function resolveEpochRoute(method: string | undefined, rawUrl: string | undefined): RouteDecision {
  // origin-form만 받는다. absolute-form·authority-form·asterisk-form(프록시 요청)은 여기서 끝난다.
  if (!rawUrl || !rawUrl.startsWith("/") || rawUrl.startsWith("//")) return { ok: false, status: 400 };
  const cut = rawUrl.indexOf("?");
  const path = cut < 0 ? rawUrl : rawUrl.slice(0, cut);
  const rawQuery = cut < 0 ? "" : rawUrl.slice(cut + 1);
  if (!SAFE_PATH.test(path) || !SAFE_QUERY.test(rawQuery)) return { ok: false, status: 400 };
  const segments = path.split("/").slice(1);
  if (segments.some((segment, index) => segment === "." || segment === ".." || (segment === "" && index !== segments.length - 1))) return { ok: false, status: 400 };
  const query = parseQuery(rawQuery);
  if (query === null) return { ok: false, status: 400 };

  if (method === "POST") {
    // 합성 join은 절대 조인하지 않는다 — SPA의 재개 시도에 늘 401로 답해 재합류 경로를 구조적으로 닫는다.
    return path === "/api/v1/join" && query.size === 0 ? { ok: true, route: { kind: "synthetic", id: "join" } } : { ok: false, status: 404 };
  }
  if (method !== "GET") return { ok: false, status: 404 };

  if (path === "/console" || path.startsWith("/console/")) {
    if (query.size > 0) return { ok: false, status: 404 };
    const relative = path === "/console" ? "" : path.slice("/console/".length);
    if (relative === "" ) return { ok: true, route: { kind: "static", relative: "index.html" } };
    if (relative === "theme-boot.js" || relative === "favicon.svg" || ASSET.test(relative)) return { ok: true, route: { kind: "static", relative } };
    // 확장자 없는 SPA 경로는 진입 문서다. 그 밖의 파일 이름은 없다.
    if (!relative.includes(".") && SPA_ROUTE.test(relative)) return { ok: true, route: { kind: "static", relative: "index.html" } };
    return { ok: false, status: 404 };
  }

  const theaterOnly = (): boolean => [...query.keys()].every((key) => key === "theaterId") && (query.get("theaterId") === undefined || ID.test(query.get("theaterId")!));
  const none = query.size === 0;
  const upstream = (transport: "http" | "sse", events?: readonly string[]): RouteDecision =>
    ({ ok: true, route: { kind: "upstream", transport, path: rawQuery ? `${path}?${rawQuery}` : path, ...(events ? { events } : {}) } });

  switch (path) {
    case "/api/v1/status": return theaterOnly() ? { ok: true, route: { kind: "synthetic", id: "status" } } : { ok: false, status: 404 };
    case "/api/v1/settings/global": return none ? { ok: true, route: { kind: "synthetic", id: "settings" } } : { ok: false, status: 404 };
    case "/plugin-runtime/manifest": return none ? { ok: true, route: { kind: "synthetic", id: "manifest" } } : { ok: false, status: 404 };
    case "/api/v1/proxy/state": return none ? { ok: true, route: { kind: "synthetic", id: "proxy-state" } } : { ok: false, status: 404 };
    case "/api/v1/theaters": return none ? upstream("http") : { ok: false, status: 404 };
    case "/api/v1/operations":
    case "/api/v1/operations/groups": return theaterOnly() ? upstream("http") : { ok: false, status: 404 };
    case "/api/v1/operations/catalog": return none ? upstream("http") : { ok: false, status: 404 };
    case "/api/v1/operations/events": return theaterOnly() ? upstream("sse", OPERATIONS_STREAM_EVENTS) : { ok: false, status: 404 };
    case "/api/v1/agent/sessions": return none ? upstream("http") : { ok: false, status: 404 };
    case "/api/v1/agent/events": return none ? upstream("sse", AGENT_STREAM_EVENTS) : { ok: false, status: 404 };
    default: break;
  }
  const operation = /^\/api\/v1\/operations\/([^/]+)$/u.exec(path);
  if (operation && UUID.test(operation[1]!) && none) return upstream("http");
  const chatCatalog = /^\/api\/v1\/agent\/sessions\/([^/]+)\/chat-catalog$/u.exec(path);
  if (chatCatalog && ID.test(chatCatalog[1]!) && none) return upstream("http");
  return { ok: false, status: 404 };
}

function parseQuery(raw: string): Map<string, string> | null {
  const query = new Map<string, string>();
  if (raw === "") return query;
  for (const pair of raw.split("&")) {
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    if (key === "" || query.has(key)) return null;
    query.set(key, value);
  }
  return query;
}
