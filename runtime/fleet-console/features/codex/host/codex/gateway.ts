import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import net from "node:net";

import { WikiKnowledgeUnavailableError } from "../wiki/index.js";
import type { MemoryPaths, WikiWorkspaceResolver } from "../wiki/index.js";

import { handleApiRequest } from "./routes.js";
import type { AllowedAccessSets } from "../../shared/contracts.js";
import { WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceRegistration } from "./workspaces.js";
import { withSecurityHeaders } from "../../shared/contracts.js";

interface CodexGatewayDeps {
  readonly host: string;
  readonly version: string;
  readonly getPort: () => number;
  /**
   * 경계 판정은 호스트가 내린다. 리스너 신원을 받아 스스로 Host/Origin 집합을 짜던 자리다 —
   * 어느 리스너로 들어왔는지, 그 리스너가 지금 무엇을 허용하는지는 Console만 안다.
   */
  /** 쓰기를 허용할 Origin 집합. 호스트의 `server.origin()`이 원본이다. */
  readonly allowedOriginsFor: (request: IncomingMessage) => readonly string[];
  readonly security: {
    readonly validateHost: (request: IncomingMessage) => boolean;
    readonly isWriteAdmitted: (request: IncomingMessage) => boolean;
  };
  /** 사령관 id → 지식 root. Codex workspace의 정체성은 사령관 id 하나다. */
  readonly wikiWorkspaceResolver: WikiWorkspaceResolver;
  /** 호스트가 아는 사령관인가 — 모르는 id로는 workspace를 열지 않는다. */
  readonly hasCommodore: (commodoreId: string) => boolean;
  /**
   * 옛 주소(`/w/<옛 id>/`)의 id를 그 맥락의 사령관 id로 바꾼다. 공유된 옛 링크를 새 주소로 넘기는 데만 쓴다.
   * 대응은 호스트가 정하고, 모르면 null이다.
   */
  readonly resolveLegacyWorkspace?: (legacyId: string) => string | null;
  /**
   * 지식 루트가 해석될 때마다 불린다(멱등). 호스트는 이 신호로 감시를 시작해, 화면이
   * 열려 있는 워크스페이스만 지켜본다.
   */
  readonly onKnowledgeRootResolved?: (workspaceId: string, knowledgeRoot: string) => void;
}

type WorkspaceSelection =
  | { kind: "workspace"; workspace: WorkspaceRegistration | null; rewrittenUrl?: string }
  | { kind: "commodore"; commodoreId: string; suffix: string; search: string }
  | { kind: "legacy"; legacyId: string; suffix: string; search: string }
  | { kind: "redirect"; location: string }
  | { kind: "not-codex" };

type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface CodexGateway {
  getWorkspace(id: string): WorkspaceRegistration | null;
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  /** 사령관 id의 workspace를 열고 지식 root를 해석한다(첫 해석이 옛 위키 이주를 마친다). */
  resolveWorkspace(commodoreId: string): CodexWorkspaceResolution;
}

export interface CodexWorkspaceResolution {
  readonly hasWiki: boolean;
  readonly id: string | null;
}

const CODEX_BASE = "/console/codex";
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);
const LOOPBACK_ACCESS_HOSTS = ["127.0.0.1", "::1"];
const LOOPBACK_HOST = "127.0.0.1";

export function createCodexGateway(deps: CodexGatewayDeps): CodexGateway {
  const workspaces = new WorkspaceRegistry();

  /** 주소가 가리키는 사령관 workspace를 연다. 호스트가 모르는 사령관이면 열지 않는다. */
  function openWorkspace(commodoreId: string): WorkspaceRegistration | null {
    return workspaces.get(commodoreId) ?? (deps.hasCommodore(commodoreId) ? workspaces.register(commodoreId) : null);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    let selected: WorkspaceSelection;
    try {
      selected = selectWorkspace(request.url ?? "/", workspaces);
    } catch (error) {
      if (error instanceof URIError) {
        sendJson(response, 400, { error: "bad request" });
        return true;
      }
      throw error;
    }
    if (selected.kind === "not-codex") return false;
    if (!ALLOWED_METHODS.has(request.method ?? "")) {
      sendMethodNotAllowed(response);
      return true;
    }
    const port = deps.getPort();
    if (!deps.security.validateHost(request)) {
      sendJson(response, 403, { error: "host_mismatch" });
      return true;
    }
    if (selected.kind === "redirect") {
      redirect(response, `${CODEX_BASE}${selected.location}`);
      return true;
    }
    // 주소의 id로 workspace를 열거나 옛 id를 사령관으로 바꾸는 일은 Host 검증을 지난 요청만 한다(호스트가 사령관을 발급할 수 있다).
    if (selected.kind === "legacy") {
      // 옛 주소는 그 맥락의 사령관 주소로 넘긴다 — 공유된 링크가 계속 열리게. 307은 POST 본문도 그대로 넘긴다.
      const commodoreId = deps.resolveLegacyWorkspace?.(selected.legacyId) ?? null;
      if (commodoreId) redirect(response, `${CODEX_BASE}/c/${encodeURIComponent(commodoreId)}${selected.suffix}${selected.search}`, 307);
      else if (selected.suffix.startsWith("/api/")) sendJson(response, 404, { error: "workspace_not_found" });
      else redirect(response, `${CODEX_BASE}/`);
      return true;
    }
    if (selected.kind === "commodore") {
      const opened = openWorkspace(selected.commodoreId);
      if (!opened) {
        if (selected.suffix.startsWith("/api/")) sendJson(response, 404, { error: "workspace_not_found" });
        else redirect(response, `${CODEX_BASE}/`);
        return true;
      }
      selected = { kind: "workspace", workspace: opened, rewrittenUrl: `${selected.suffix}${selected.search}` };
    }
    const workspace = selected.workspace;
    if (!workspace) {
      // 열린 위키가 없으면 보여 줄 위키도 없다 — 없는 것을 지어내지 않는다.
      // 화면 요청은 콘솔 SPA가 답한다: 여기서 CODEX_BASE로 되돌리면 이미 그 주소에
      // 있는 요청이 자기 자신으로 무한히 튕긴다.
      // 쓰기는 화면 이동이 아니다 — SPA로 흘려보내면 코어가 "Method not allowed"로
      // 답해, 호출자는 자기 요청이 어디서 막혔는지 알 수 없다.
      const navigational = request.method === "GET" || request.method === "HEAD";
      if (!navigational || isJsonRequest(request)) {
        sendJson(response, 404, { error: "no_workspace_registered" });
        return true;
      }
      return false;
    }
    const originalUrl = request.url;
    if (selected.rewrittenUrl) request.url = selected.rewrittenUrl;
    let paths: MemoryPaths;
    try {
      paths = deps.wikiWorkspaceResolver.resolve(workspace.id);
    } catch (error) {
      request.url = originalUrl;
      sendJson(response, error instanceof WikiKnowledgeUnavailableError ? 404 : 500, { error: error instanceof WikiKnowledgeUnavailableError ? "knowledge_unavailable" : "internal_error" });
      return true;
    }
    const handled = await handleApiRequest(request, response, {
      knowledgeRoot: paths.root,
      paths,
      host: deps.host,
      port,
      workspaceId: workspace.id,
      // Origin 허용집합은 콘솔 자신의 오리진이다 — 리스너별 집합을 플러그인이 다시 짜면
      // 그 사본이 호스트의 경계와 갈라진다. 쓰기 자격 판정은 호스트가 내린다.
      allowedOrigins: new Set(deps.allowedOriginsFor(request)),
      externalMode: true,
      admitted: deps.security.isWriteAdmitted(request),
    });
    request.url = originalUrl;
    // 감시는 요청을 처리한 *뒤에* 시작한다 — 지식 루트를 만드는 것은 그 요청이고,
    // 아직 없는 경로에 감시를 붙이면 첫 화면이 degraded부터 보게 된다.
    deps.onKnowledgeRootResolved?.(workspace.id, paths.root);
    return handled;
  }

  function resolveWorkspace(commodoreId: string): CodexWorkspaceResolution {
    const workspace = openWorkspace(commodoreId);
    if (!workspace) return { hasWiki: false, id: null };
    // 여기서는 감시를 걸지 않는다. 해석은 이주를 마칠 뿐 지식 루트를 만들지 않으므로, 한 번도 쓰인 적 없는
    // 사령관이라면 아직 그 디렉터리가 없다. 패널은 곧바로 카탈로그를 요청하고, 그 요청이 루트를 만든 뒤 감시가 시작된다.
    deps.wikiWorkspaceResolver.resolve(workspace.id);
    return { hasWiki: true, id: workspace.id };
  }

  return {
    getWorkspace: (id) => workspaces.get(id),
    handle,
    resolveWorkspace,
  };
}

export function buildAllowedAccessSets(
  host: string,
  port: number,
  interfaces: NetworkInterfaces = os.networkInterfaces(),
): AllowedAccessSets {
  const hosts = isWildcardBindHost(host)
    ? enumerateWildcardAccessHosts(interfaces)
    : isDualBindHost(host)
      ? [host, LOOPBACK_HOST]
      : [host];
  const allowedHosts = new Set<string>();
  const allowedOrigins = new Set<string>();
  for (const item of hosts) {
    const canonical = canonicalizeAllowedHost(item);
    if (!canonical) continue;
    allowedHosts.add(canonical);
    allowedOrigins.add(`http://${formatHostForUrl(canonical)}:${port}`);
  }
  return { allowedHosts, allowedOrigins, externalMode: !isLoopbackBindHost(host) };
}

/**
 * 원격 리스너의 경계는 그 리스너 하나다. 바인드 호스트에서 파생한 집합은 루프백을 동반하고
 * 스킴이 http로 고정돼 있어, TLS로 뜬 원격 리스너는 자기 주소도 자기 Origin도 통과시키지 못한다.
 */

/**
 * 쓰기 자격은 "이 기계에서 왔는가"가 아니라 "어느 리스너를 통과했는가"다. 원격 리스너 요청은
 * 라우팅 이전에 세션 게이트를 통과했고, monitoring 자격은 거기서 이미 읽기로 묶인다 — 여기서
 * 피어 주소를 다시 보면 원격은 세션이 있어도 영원히 읽기 전용이 된다.
 */

function selectWorkspace(requestUrl: string, workspaces: WorkspaceRegistry): WorkspaceSelection {
  const url = new URL(requestUrl, "http://127.0.0.1");
  decodeURI(url.pathname);
  if (url.pathname === CODEX_BASE || url.pathname === `${CODEX_BASE}/`) {
    url.pathname = "/";
    return { kind: "workspace", workspace: workspaces.getMru(), rewrittenUrl: `${url.pathname}${url.search}` };
  }
  if (!url.pathname.startsWith(`${CODEX_BASE}/`)) return { kind: "not-codex" };
  const codexPath = url.pathname.slice(CODEX_BASE.length) || "/";
  url.pathname = codexPath;
  const prefixed = url.pathname.match(/^\/c\/([^/]+)(\/.*)?$/);
  if (prefixed) return { kind: "commodore", commodoreId: decodeURIComponent(prefixed[1] ?? ""), suffix: prefixed[2] ?? "/", search: url.search };
  const legacy = url.pathname.match(/^\/w\/([^/]+)(\/.*)?$/);
  if (legacy) return { kind: "legacy", legacyId: decodeURIComponent(legacy[1] ?? ""), suffix: legacy[2] ?? "/", search: url.search };
  if (url.pathname.startsWith("/api/")) {
    const workspace = workspaces.getMru();
    return { kind: "workspace", workspace, rewrittenUrl: `${url.pathname}${url.search}` };
  }
  const legacyTarget = legacyWorkspacePath(url);
  if (legacyTarget) {
    const workspace = workspaces.getMru();
    if (!workspace) return { kind: "redirect", location: "/" };
    return { kind: "redirect", location: `/c/${encodeURIComponent(workspace.id)}${legacyTarget}` };
  }
  return { kind: "workspace", workspace: workspaces.getMru(), rewrittenUrl: `${url.pathname}${url.search}` };
}

function sendMethodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, withSecurityHeaders({ allow: "GET, HEAD, POST", "content-type": "application/json; charset=utf-8" }));
  response.end(JSON.stringify({ error: "method_not_allowed" }));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, withSecurityHeaders({ "content-type": "application/json; charset=utf-8" }));
  response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, location: string, status: 302 | 307 = 302): void {
  response.writeHead(status, withSecurityHeaders({ location }));
  response.end();
}

function legacyWorkspacePath(url: URL): string | null {
  const pathname = url.pathname;
  if (
    pathname.startsWith("/entry/")
  ) {
    return `${pathname}${url.search}`;
  }
  return null;
}

function isJsonRequest(request: { headers: { accept?: string | string[]; "x-requested-with"?: string | string[] } }): boolean {
  const accept = Array.isArray(request.headers.accept) ? request.headers.accept.join(",") : request.headers.accept ?? "";
  const requestedWith = Array.isArray(request.headers["x-requested-with"])
    ? request.headers["x-requested-with"].join(",")
    : request.headers["x-requested-with"] ?? "";
  return accept.includes("application/json") || requestedWith.toLowerCase() === "xmlhttprequest";
}

function formatHostForUrl(host: string): string {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

function canonicalizeAllowedHost(host: string): string | null {
  const unbracketed = stripIpv6Brackets(host).toLowerCase();
  if (unbracketed.includes("%")) return null;
  if (isIpv4MappedAddress(unbracketed)) return null;
  if (net.isIP(unbracketed) === 6) {
    try {
      return stripIpv6Brackets(new URL(`http://[${unbracketed}]:1`).hostname).toLowerCase();
    } catch {
      return null;
    }
  }
  return unbracketed;
}

function enumerateWildcardAccessHosts(interfaces: NetworkInterfaces): string[] {
  const hosts = [...LOOPBACK_ACCESS_HOSTS];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (net.isIP(entry.address) === 0) continue;
      hosts.push(entry.address);
    }
  }
  return hosts;
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = stripIpv6Brackets(host).toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function isDualBindHost(host: string): boolean {
  return !isLoopbackBindHost(host) && !isWildcardBindHost(host);
}

function isIpv4MappedAddress(host: string): boolean {
  return host.startsWith("::ffff:");
}

function isWildcardBindHost(host: string): boolean {
  return WILDCARD_HOSTS.has(stripIpv6Brackets(host).toLowerCase());
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}
