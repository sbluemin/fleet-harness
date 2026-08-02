import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import net from "node:net";

import type { MemoryPaths, WikiWorkspaceResolver } from "@dotobokuri/fleet-wiki";

import { handleApiRequest } from "./routes.js";
import { CoworkService, CoworkStore } from "@dotobokuri/fleet-wiki/cowork";
import type { CoworkConnector } from "@dotobokuri/fleet-wiki/cowork";
import { UnifiedAgent } from "@dotobokuri/core-unified-agent";
import type { UnifiedClientOptions } from "@dotobokuri/core-unified-agent";
import type { AllowedAccessSets } from "./contracts.js";
import { WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceRegistration } from "./workspaces.js";
import { withSecurityHeaders } from "../security-headers.js";

interface CodexGatewayDeps {
  readonly cwd: string;
  readonly host: string;
  readonly version: string;
  readonly getPort: () => number;
  readonly wikiWorkspaceResolver: WikiWorkspaceResolver;
  readonly dataDir?: string;
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
  const workspaces = new WorkspaceRegistry();
  const workspaceOwners = new Map<string, Set<string>>();
  let accessSets: AllowedAccessSets | null = null;
  let initialWorkspace: Promise<WorkspaceRegistration> | null = null;
  let initialWorkspaceId: string | null = null;
  const coworkServices = new Map<string, CoworkService>();
  // provider 조립은 호스트 소유 — fleet-wiki cowork 엔진에는 커넥터만 주입한다.
  const coworkConnector: CoworkConnector = { connect: (options) => UnifiedAgent.connect(options as unknown as UnifiedClientOptions) };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    let selected: WorkspaceSelection;
    try {
      selected = await selectWorkspace(request.url ?? "/", workspaces, deps.cwd);
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
    accessSets ??= buildAllowedAccessSets(deps.host, port);
    if (!isHostAllowed(request.rawHeaders, request.url ?? "/", accessSets.allowedHosts, port)) {
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
      allowedOrigins: accessSets.allowedOrigins,
      externalMode: accessSets.externalMode,
      coworkService,
    });
    request.url = originalUrl;
    return handled;
  }

  async function ensureInitialWorkspace(): Promise<WorkspaceRegistration> {
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
