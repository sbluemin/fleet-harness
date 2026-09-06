import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import net from "node:net";

import type { MemoryPaths, WikiWorkspaceResolver } from "@dotobokuri/fleet-wiki";

import { handleApiRequest } from "./routes.js";
import { CoworkService, CoworkStore } from "@dotobokuri/fleet-wiki/cowork";
import type { CoworkConnector } from "@dotobokuri/fleet-wiki/cowork";
import { AI_GATEWAY_ROUTE_SEGMENT, resolveAiGatewaySelection, type AiGatewayStoredSettings } from "@dotobokuri/core-ai-gateway";

import { createCoworkGatewayConnector } from "./cowork/gateway-adapter.js";
import type { AllowedAccessSets } from "./contracts.js";
import type { TheaterPathResolver } from "./theater-paths.js";
import { WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceRegistration } from "./workspaces.js";
import { withSecurityHeaders } from "./contracts.js";

interface CodexGatewayDeps {
  /**
   * 등록된 워크스페이스가 하나도 없을 때 쓸 기본 프로젝트. 플러그인에는 그런 것이
   * 없으므로 생략한다 — 프로세스의 cwd를 기본값으로 삼으면 콘솔 패키지 자신이
   * 워크스페이스가 되어, 사용자가 연 적 없는 빈 위키를 MRU로 돌려준다.
   */
  readonly cwd?: string;
  readonly host: string;
  readonly version: string;
  readonly getPort: () => number;
  /**
   * 요청이 도착한 리스너. Codex는 코어 Host 게이트보다 앞에서 분기하므로 자기 게이트가 유일한
   * 경계인데, 그 경계는 바인드 호스트가 아니라 리스너마다 다르다. 원격 리스너를 모르는 게이트는
   * 원격에서 연 Wiki를 전부 host_mismatch로 되돌린다.
   */
  /**
   * 경계 판정은 호스트가 내린다. 리스너 신원을 받아 스스로 Host/Origin 집합을 짜던 자리다 —
   * 어느 리스너로 들어왔는지, 그 리스너가 지금 무엇을 허용하는지는 Console만 안다.
   */
  /** 쓰기를 허용할 Origin 집합. 호스트의 `server.origin()`이 원본이다. */
  readonly allowedOriginsFor: (request: IncomingMessage) => readonly string[];
  readonly theaterPaths: TheaterPathResolver;
  /**
   * 아직 등록되지 않은 워크스페이스를 요청받았을 때 그 뿌리를 찾아 준다.
   *
   * 등록을 이벤트에 맡기면 "Theater를 더한 직후의 요청"이 등록을 앞지른다 — 방금 만든
   * Theater의 위키가 없다고 답하는 창이 생긴다. 순서를 맞추는 대신 순서 의존을 없앤다:
   * 필요할 때 열고, 이벤트는 미리 데워 두는 역할만 한다.
   */
  readonly resolveWorkspaceRoot?: (workspaceId: string) => string | null;
  /**
   * 아직 끝나지 않은 등록이 있으면 그것을 기다린다.
   *
   * Theater 등록은 이벤트로 도착하고 그 처리는 비동기다. MRU 경로에는 되찾을 id조차
   * 없으므로, 답하기 전에 진행 중인 등록을 한 번 기다리는 것이 순서 의존을 없애는
   * 유일한 지점이다.
   */
  readonly whenRegistrationsSettle?: () => Promise<void>;
  /**
   * 사용자가 켠 Gateway 모델 선별. Cowork 모델 목록이 켜진 좌표만 싣도록 요청마다 읽는다 —
   * 등록 시점에 고정하면 이후 설정 변경이 목록에 반영되지 않는다. 생략하면 카탈로그 모델을 싣지 않는다.
   */
  readonly readAiGatewaySettings?: () => AiGatewayStoredSettings;
  readonly security: {
    readonly validateHost: (request: IncomingMessage) => boolean;
    readonly isWriteAdmitted: (request: IncomingMessage) => boolean;
  };
  readonly wikiWorkspaceResolver: WikiWorkspaceResolver;
  readonly dataDir?: string;
  /**
   * 지식 루트가 해석될 때마다 불린다(멱등). 호스트는 이 신호로 감시를 시작해, 화면이
   * 열려 있는 워크스페이스만 지켜본다.
   */
  readonly onKnowledgeRootResolved?: (workspaceId: string, knowledgeRoot: string) => void;
  /** 워크스페이스 등록이 풀렸다 — 감시도 함께 끝나야 한다. */
  readonly onWorkspaceReleased?: (workspaceId: string) => void;
}

interface ParsedHostHeader {
  host: string;
  port: number;
}

type WorkspaceSelection =
  | { kind: "workspace"; workspace: WorkspaceRegistration | null; rewrittenUrl?: string }
  | { kind: "missing-workspace" }
  | { kind: "redirect"; location: string }
  | { kind: "no-workspace" }
  | { kind: "not-codex" };

type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface CodexGateway {
  getWorkspace(id: string): WorkspaceRegistration | null;
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  listWorkspaceRegistrations(): readonly WorkspaceRegistration[];
  registerWorkspace(cwd: string, lastOpenedAt?: string, ownerTheaterId?: string): Promise<WorkspaceRegistration>;
  resolveWorkspaceForTheater(theaterId: string, theaterRoot: string): Promise<CodexWorkspaceResolution>;
  unregisterTheaterWorkspaces(theaterId: string): void;
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
  const workspaces = new WorkspaceRegistry(deps.theaterPaths);
  const workspaceOwners = new Map<string, Set<string>>();
  let initialWorkspace: Promise<WorkspaceRegistration> | null = null;
  let initialWorkspaceId: string | null = null;
  const coworkServices = new Map<string, CoworkService>();
  // provider 조립은 호스트 소유 — fleet-wiki cowork 엔진에는 커넥터만 주입한다.
  // AI Gateway는 terminal 플러그인이 서빙하고, 그 basePath는 이 호스트가 안다.
  const coworkConnector: CoworkConnector = createCoworkGatewayConnector({
    baseUrl: () => {
      const port = deps.getPort();
      return port ? `http://127.0.0.1:${port}/plugins/terminal/${AI_GATEWAY_ROUTE_SEGMENT}` : null;
    },
  });

  /**
   * 주소가 가리키는 워크스페이스를 지금 연다. 이미 열려 있거나 뿌리를 못 찾으면 false.
   * 등록은 멱등이므로 이벤트 경로와 겹쳐도 두 벌이 생기지 않는다.
   */
  async function openMissingWorkspace(requestUrl: string): Promise<boolean> {
    const resolveRoot = deps.resolveWorkspaceRoot;
    if (!resolveRoot) return false;
    const match = new URL(requestUrl, "http://127.0.0.1").pathname
      .slice(CODEX_BASE.length)
      .match(/^\/w\/([^/]+)(?:\/.*)?$/);
    const workspaceId = match ? decodeURIComponent(match[1] ?? "") : null;
    if (!workspaceId || workspaces.get(workspaceId)) return false;
    const root = resolveRoot(workspaceId);
    if (!root) return false;
    await registerWorkspace(root, undefined, workspaceId);
    return workspaces.get(workspaceId) !== null;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    await deps.whenRegistrationsSettle?.();
    let selected: WorkspaceSelection;
    try {
      selected = await selectWorkspace(request.url ?? "/", workspaces, deps.cwd ?? "");
      // 모르는 워크스페이스라면 한 번은 열어 보고 다시 고른다.
      if (selected.kind === "missing-workspace" || selected.kind === "redirect" || selected.kind === "no-workspace") {
        if (await openMissingWorkspace(request.url ?? "/")) {
          selected = await selectWorkspace(request.url ?? "/", workspaces, deps.cwd ?? "");
        }
      }
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
    if (selected.kind === "missing-workspace") {
      sendJson(response, 404, { error: "workspace_not_found" });
      return true;
    }
    if (selected.kind === "no-workspace") {
      if (isJsonRequest(request)) {
        sendJson(response, 404, { error: "no_workspace_registered" });
        return true;
      }
      redirect(response, CODEX_BASE);
      return true;
    }
    const workspace = selected.workspace ?? await ensureInitialWorkspace();
    if (!workspace) {
      // 열린 Theater가 없으면 보여 줄 위키도 없다 — 없는 것을 지어내지 않는다.
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
      paths = deps.wikiWorkspaceResolver.resolve(workspace.realpath);
    } catch {
      sendJson(response, 500, { error: "internal_error" });
      return true;
    }
    const coworkService = coworkServices.get(workspace.id) ?? new CoworkService(new CoworkStore(), paths, workspace.cwd, coworkConnector, deps.wikiWorkspaceResolver);
    coworkServices.set(workspace.id, coworkService);
    const handled = await handleApiRequest(request, response, {
      cwd: workspace.cwd,
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
      coworkService,
      enabledGatewayModelIds: new Set(
        deps.readAiGatewaySettings ? resolveAiGatewaySelection(deps.readAiGatewaySettings()).models.map((model) => model.id) : [],
      ),
    });
    request.url = originalUrl;
    // 감시는 요청을 처리한 *뒤에* 시작한다 — 지식 루트를 만드는 것은 그 요청이고,
    // 아직 없는 경로에 감시를 붙이면 첫 화면이 degraded부터 보게 된다.
    deps.onKnowledgeRootResolved?.(workspace.id, paths.root);
    return handled;
  }

  /**
   * 루프백 리스너와 리스너를 찾지 못한 요청은 바인드 호스트에서 파생한 기존 집합을 그대로 쓴다 —
   * wildcard 바인드가 열어 두던 LAN 주소 집합을 좁히지 않기 위해서다. 원격 리스너는 그와 달리
   * 자기 주소 하나만 연다.
   */


  async function ensureInitialWorkspace(): Promise<WorkspaceRegistration | null> {
    if (!deps.cwd) return null;
    initialWorkspace ??= workspaces.register(deps.cwd);
    const workspace = await initialWorkspace;
    initialWorkspaceId = workspace.id;
    return workspace;
  }

  async function registerWorkspace(
    cwd: string,
    lastOpenedAt?: string,
    ownerTheaterId?: string,
  ): Promise<WorkspaceRegistration> {
    const workspace = await workspaces.register(cwd, lastOpenedAt);
    if (ownerTheaterId) {
      const owners = workspaceOwners.get(workspace.id) ?? new Set<string>();
      owners.add(ownerTheaterId);
      workspaceOwners.set(workspace.id, owners);
    }
    return workspace;
  }

  async function resolveWorkspaceForTheater(
    theaterId: string,
    theaterRoot: string,
  ): Promise<CodexWorkspaceResolution> {
    const workspace = await registerWorkspace(theaterRoot, undefined, theaterId);
    // 여기서는 감시를 걸지 않는다. 이 경로는 워크스페이스를 해석만 하고 지식 루트를 만들지
    // 않으므로, 한 번도 열린 적 없는 Theater라면 아직 그 디렉토리가 없다. 패널은 곧바로
    // 카탈로그를 요청하고, 그 요청이 루트를 만든 뒤 감시가 시작된다.
    deps.wikiWorkspaceResolver.resolve(workspace.realpath);
    return { hasWiki: true, id: workspace.id };
  }

  function unregisterWorkspace(id: string): boolean {
    // 캐시된 initial workspace가 해제 대상이면 캐시를 비워, 이후 비프리픽스 라우트가
    // 레지스트리에서 사라진 등록을 계속 서빙하지 않게 한다(다음 접근 시 재평가).
    if (initialWorkspaceId === id) {
      initialWorkspace = null;
      initialWorkspaceId = null;
    }
    // Cowork 캐시도 함께 해제 — 라우트가 사라진 뒤 라이브 provider 클라이언트가
    // 취소 불가능한 상태로 잔존하면 안 된다.
    const coworkService = coworkServices.get(id);
    if (coworkService) {
      coworkServices.delete(id);
      void coworkService.dispose().catch(() => undefined);
    }
    deps.onWorkspaceReleased?.(id);
    return workspaces.remove(id);
  }

  function unregisterTheaterWorkspaces(theaterId: string): void {
    for (const [workspaceId, owners] of workspaceOwners) {
      owners.delete(theaterId);
      if (owners.size === 0) {
        workspaceOwners.delete(workspaceId);
        unregisterWorkspace(workspaceId);
      }
    }
  }

  return {
    getWorkspace: (id) => workspaces.get(id),
    handle,
    listWorkspaceRegistrations: () => workspaces.listRegistrations(),
    registerWorkspace,
    resolveWorkspaceForTheater,
    unregisterTheaterWorkspaces,
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

function selectWorkspace(requestUrl: string, workspaces: WorkspaceRegistry, cwd: string): WorkspaceSelection {
  const url = new URL(requestUrl, "http://127.0.0.1");
  decodeURI(url.pathname);
  if (url.pathname === CODEX_BASE || url.pathname === `${CODEX_BASE}/`) {
    url.pathname = "/";
    return { kind: "workspace", workspace: workspaces.getMru(), rewrittenUrl: `${url.pathname}${url.search}` };
  }
  if (!url.pathname.startsWith(`${CODEX_BASE}/`)) return { kind: "not-codex" };
  const codexPath = url.pathname.slice(CODEX_BASE.length) || "/";
  url.pathname = codexPath;
  const prefixed = url.pathname.match(/^\/w\/([^/]+)(\/.*)?$/);
  if (prefixed) {
    const workspace = workspaces.get(decodeURIComponent(prefixed[1] ?? ""));
    const suffix = prefixed[2] ?? "/";
    if (!workspace) {
      return suffix.startsWith("/api/") ? { kind: "missing-workspace" } : { kind: "redirect", location: "/" };
    }
    url.pathname = suffix;
    return { kind: "workspace", workspace, rewrittenUrl: `${url.pathname}${url.search}` };
  }
  if (url.pathname.startsWith("/api/")) {
    const workspace = workspaces.getMru();
    return { kind: "workspace", workspace, rewrittenUrl: `${url.pathname}${url.search}` };
  }
  const legacyTarget = legacyWorkspacePath(url);
  if (legacyTarget) {
    const workspace = workspaces.getMru();
    if (!workspace) return { kind: "redirect", location: "/" };
    return { kind: "redirect", location: `/w/${encodeURIComponent(workspace.id)}${legacyTarget}` };
  }
  if (!workspaces.getMru()) {
    void workspaces.register(cwd);
  }
  return { kind: "workspace", workspace: workspaces.getMru(), rewrittenUrl: `${url.pathname}${url.search}` };
}

function isHostAllowed(rawHeaders: string[], requestUrl: string, allowedHosts: Set<string>, serverPort: number): boolean {
  if (/^https?:\/\//i.test(requestUrl)) return false;
  const hostHeaders = readRawHeaderValues(rawHeaders, "host");
  if (hostHeaders.length !== 1) return false;
  const parsed = parseHostHeader(hostHeaders[0] ?? "");
  if (!parsed || parsed.port !== serverPort) return false;
  return allowedHosts.has(parsed.host);
}

function sendMethodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, withSecurityHeaders({ allow: "GET, HEAD, POST", "content-type": "application/json; charset=utf-8" }));
  response.end(JSON.stringify({ error: "method_not_allowed" }));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, withSecurityHeaders({ "content-type": "application/json; charset=utf-8" }));
  response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, withSecurityHeaders({ location }));
  response.end();
}

function legacyWorkspacePath(url: URL): string | null {
  const pathname = url.pathname;
  if (
    pathname.startsWith("/entry/")
    || pathname === "/conflicts"
    || pathname.startsWith("/conflicts/")
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

function parseHostHeader(value: string): ParsedHostHeader | null {
  if (!value || value.includes(",") || /^https?:\/\//i.test(value)) return null;
  if (value.startsWith("[")) {
    const match = value.match(/^\[([^\]]+)\]:(\d+)$/);
    if (!match) return null;
    const host = canonicalizeAllowedHost(match[1] ?? "");
    const port = Number(match[2] ?? "");
    if (!host || !Number.isInteger(port)) return null;
    return { host, port };
  }
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const host = canonicalizeAllowedHost(parts[0] ?? "");
  const port = Number(parts[1] ?? "");
  if (!host || !Number.isInteger(port)) return null;
  if (net.isIP(host) === 6) return null;
  return { host, port };
}

function readRawHeaderValues(rawHeaders: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if ((rawHeaders[index] ?? "").toLowerCase() === name) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}
