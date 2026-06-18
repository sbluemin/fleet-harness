import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import net from "node:net";

import { handleApiRequest } from "./routes.js";
import type { AllowedAccessSets } from "./types.js";
import { WorkspaceRegistry } from "./workspaces.js";
import type { WorkspaceRegistration } from "./workspaces.js";
import { withSecurityHeaders } from "../security-headers.js";

interface CodexGatewayDeps {
  readonly cwd: string;
  readonly host: string;
  readonly version: string;
  readonly getPort: () => number;
  readonly getAdminToken: () => string | null;
}

interface ParsedHostHeader {
  host: string;
  port: number;
}

type WorkspaceSelection =
  | { kind: "workspace"; workspace: WorkspaceRegistration | null; rewrittenUrl?: string }
  | { kind: "redirect"; location: string }
  | { kind: "no-workspace" }
  | { kind: "not-codex" };

type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

const CODEX_BASE = "/console/codex";
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);
const LOOPBACK_ACCESS_HOSTS = ["127.0.0.1", "::1"];
const LOOPBACK_HOST = "127.0.0.1";

export interface CodexGateway {
  getWorkspace(id: string): WorkspaceRegistration | null;
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  listWorkspaceRegistrations(): readonly WorkspaceRegistration[];
  registerWorkspace(cwd: string): Promise<WorkspaceRegistration>;
  unregisterWorkspace(id: string): boolean;
}

export function createCodexGateway(deps: CodexGatewayDeps): CodexGateway {
  const workspaces = new WorkspaceRegistry();
  let accessSets: AllowedAccessSets | null = null;
  let initialWorkspace: Promise<WorkspaceRegistration> | null = null;

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
    const handled = await handleApiRequest(request, response, {
      cwd: workspace.cwd,
      knowledgeRoot: workspace.paths.root,
      paths: workspace.paths,
      version: deps.version,
      host: deps.host,
      port,
      workspaceId: workspace.id,
      workspaces,
      adminToken: deps.getAdminToken() ?? undefined,
      allowedOrigins: accessSets.allowedOrigins,
      externalMode: accessSets.externalMode,
    });
    request.url = originalUrl;
    return handled;
  }

  async function ensureInitialWorkspace(): Promise<WorkspaceRegistration> {
    initialWorkspace ??= workspaces.register(deps.cwd);
    return initialWorkspace;
  }

  return {
    getWorkspace: (id) => workspaces.get(id),
    handle,
    listWorkspaceRegistrations: () => workspaces.listRegistrations(),
    registerWorkspace: (cwd) => workspaces.register(cwd),
    unregisterWorkspace: (id) => workspaces.remove(id),
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
    if (!workspace) return { kind: "redirect", location: "/" };
    const suffix = prefixed[2] ?? "/";
    url.pathname = suffix;
    return { kind: "workspace", workspace, rewrittenUrl: `${url.pathname}${url.search}` };
  }
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname === "/api/health" || url.pathname === "/api/admin/workspaces") {
      return { kind: "workspace", workspace: workspaces.getMru(), rewrittenUrl: `${url.pathname}${url.search}` };
    }
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
    || pathname.startsWith("/raw/")
    || pathname === "/queue"
    || pathname.startsWith("/queue/")
    || pathname === "/conflicts"
    || pathname.startsWith("/conflicts/")
    || pathname === "/index-md"
    || pathname === "/log"
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
