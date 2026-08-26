import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";


import { buildApiCatalog, type ApiCatalogEntry } from "../core/host/api-catalog.js";
import type { ConsoleLockPayload } from "../core/host/console-contract-types.js";
import { createConsoleLock } from "../core/host/lock.js";
import { createConsoleServer, PAIRING_IDENTITY, PAIRING_IDENTITY_PATH, type ConsoleServer } from "../core/host/server.js";
import type { SystemFontsService } from "../core/host/system-fonts.js";

interface ServerFixture {
  readonly dir: string;
  readonly fleetDataDir: string;
  readonly lockFile: string;
  readonly server: ConsoleServer;
  readonly endpoint: string;
  readonly lock: ConsoleLockPayload;
}

interface FakeConsoleRuntime {
  readonly cleanup: ReturnType<typeof vi.fn>;
}

interface ApiCatalogResponse {
  readonly version: string;
  readonly routes: ApiCatalogEntry[];
}

interface HostDeniedResponse {
  readonly status: number;
  readonly body: unknown;
}

const ALLOWED_ROUTE_KEYS = ["method", "path", "summary", "category", "gate", "transport"].sort();
const SYSTEM_FONTS_PATH = "/api/v1/settings/fonts/system";
const INJECTED_SYSTEM_FONTS = [{ family: "Noto Sans", monospace: false, uiSuitable: true }];
const EXPECTED_API_CATALOG_IDENTITIES = `
*|/plugins/terminal/ai-gateway/api/hello|http
*|/plugins/terminal/ai-gateway/v1/models|proxy
DELETE|/api/v1/access-links/:linkId|http
DELETE|/api/v1/access-sessions/:sessionHandle|http
DELETE|/api/v1/operations/:operationId|http
DELETE|/api/v1/operations/groups/:groupId|http
DELETE|/api/v1/paired-devices/:deviceId|http
DELETE|/api/v1/remote-hosts/:hostId|http
DELETE|/api/v1/theaters/:theaterId|http
DELETE|/plugins/terminal/agent/attachments/:attachmentId|http
DELETE|/plugins/terminal/agent/sessions/:sessionId/chat|http
DELETE|/plugins/terminal/agent/sessions/:sessionId|http
DELETE|/plugins/terminal/analysis/:operationId/artifacts|http
DELETE|/plugins/terminal/model-auth/providers/:providerId|http
DELETE|/plugins/terminal/shell/sessions/:operationId|http
GET|/api/v1/access-links|http
GET|/api/v1/desktop/shell|http
GET|/api/v1/desktop/theme/events|sse
GET|/api/v1/desktop/theme|http
GET|/api/v1/desktop/update/events|sse
GET|/api/v1/desktop/update|http
GET|/api/v1/health|http
GET|/api/v1/local-consoles|http
GET|/api/v1/operations/:operationId|http
GET|/api/v1/operations/catalog|http
GET|/api/v1/operations/events|sse
GET|/api/v1/operations/groups|http
GET|/api/v1/operations|http
GET|/api/v1/pairing-identity|http
GET|/api/v1/remote-hosts|http
GET|/api/v1/settings/api-catalog|http
GET|/api/v1/settings/fonts/system|http
GET|/api/v1/settings/global|http
GET|/api/v1/settings/plugins/:pluginId|http
GET|/api/v1/status|http
GET|/api/v1/theaters|http
GET|/api/v1/updates/progress|http
GET|/api/v1/updates/release-notes|http
GET|/plugins/file-explorer/files/image|http
GET|/plugins/file-explorer/files/watch|sse
GET|/plugins/ledger/summary|http
GET|/plugins/quota/summary|http
GET|/plugins/scuttlebutt/chat/:chatId/stream|sse
GET|/plugins/skills/jobs|http
GET|/plugins/skills/list|http
GET|/plugins/skills/search|http
GET|/plugins/terminal/agent/agent-cli/diagnostics|http
GET|/plugins/terminal/agent/agent-cli/state|http
GET|/plugins/terminal/agent/events|sse
GET|/plugins/terminal/agent/sessions/:sessionId/chat-job|http
GET|/plugins/terminal/agent/sessions/:sessionId/chat-stream|http
GET|/plugins/terminal/agent/sessions|http
GET|/plugins/terminal/agent/state|http
GET|/plugins/terminal/analysis/:operationId/ready|http
GET|/plugins/terminal/analysis/:operationId/stream|sse
GET|/plugins/terminal/analysis/artifacts/:artifactId|http
GET|/plugins/terminal/analysis/catalog|http
GET|/plugins/terminal/analysis/stream|sse
GET|/plugins/terminal/model-auth/state|http
GET|/plugins/terminal/settings|http
GET|/plugins/terminal/ws|websocket
PATCH|/api/v1/operations/:operationId|http
PATCH|/api/v1/operations/groups/:groupId|http
PATCH|/api/v1/remote-hosts/:hostId|http
PATCH|/api/v1/theaters/:theaterId|http
POST|/api/v1/access-grants|http
POST|/api/v1/access-links|http
POST|/api/v1/deletions/:deletionId/restore|http
POST|/api/v1/desktop/handoff|http
POST|/api/v1/join|http
POST|/api/v1/operations/groups|http
POST|/api/v1/operations|http
POST|/api/v1/remote-hosts/:hostId/probes|http
POST|/api/v1/remote-hosts|http
POST|/api/v1/remote-identity/rotations|http
POST|/api/v1/theaters/:theaterId/codex-workspace|http
POST|/api/v1/theaters/folder-grants|http
POST|/api/v1/theaters/folder-listings|http
POST|/api/v1/theaters|http
POST|/api/v1/updates/apply|http
POST|/plugins/file-explorer/files/clipboard|http
POST|/plugins/file-explorer/files/git-status|http
POST|/plugins/file-explorer/files/list|http
POST|/plugins/file-explorer/files/palette-search|http
POST|/plugins/file-explorer/files/read|http
POST|/plugins/file-explorer/files/reveal|http
POST|/plugins/quota/connect|http
POST|/plugins/quota/fold|http
POST|/plugins/quota/order|http
POST|/plugins/repository/changed|http
POST|/plugins/repository/commit-create|http
POST|/plugins/repository/commit-file|http
POST|/plugins/repository/commit|http
POST|/plugins/repository/compare-file|http
POST|/plugins/repository/compare|http
POST|/plugins/repository/discard|http
POST|/plugins/repository/fetch|http
POST|/plugins/repository/file|http
POST|/plugins/repository/log|http
POST|/plugins/repository/palette-search|http
POST|/plugins/repository/pull|http
POST|/plugins/repository/push|http
POST|/plugins/repository/refs|http
POST|/plugins/repository/repos|http
POST|/plugins/repository/stage|http
POST|/plugins/repository/stash|http
POST|/plugins/repository/status|http
POST|/plugins/repository/tree|http
POST|/plugins/repository/unstage|http
POST|/plugins/repository/workstate|http
POST|/plugins/repository/worktrees|http
POST|/plugins/scuttlebutt/chat/:chatId/message|http
POST|/plugins/scuttlebutt/chat/:chatId/stop|http
POST|/plugins/scuttlebutt/chat/start|http
POST|/plugins/skills/installed-file|http
POST|/plugins/skills/install|http
POST|/plugins/skills/palette-search|http
POST|/plugins/skills/preview|http
POST|/plugins/skills/remove|http
POST|/plugins/skills/update|http
POST|/plugins/terminal/agent/attachments|http
POST|/plugins/terminal/agent/sessions/:sessionId/attention|http
POST|/plugins/terminal/agent/sessions/:sessionId/auto-name|http
POST|/plugins/terminal/agent/sessions/:sessionId/background|http
POST|/plugins/terminal/agent/sessions/:sessionId/capture|http
POST|/plugins/terminal/agent/sessions/:sessionId/chat-answer|http
POST|/plugins/terminal/agent/sessions/:sessionId/chat-stop|http
POST|/plugins/terminal/agent/sessions/:sessionId/chat|http
POST|/plugins/terminal/agent/sessions/:sessionId/message|http
POST|/plugins/terminal/agent/sessions/:sessionId/resume|http
POST|/plugins/terminal/agent/sessions/:sessionId/turn|http
POST|/plugins/terminal/agent/sessions|http
POST|/plugins/terminal/agent/ticket|http
POST|/plugins/terminal/ai-gateway/v1/messages|proxy
POST|/plugins/terminal/analysis/:operationId/message|http
POST|/plugins/terminal/analysis/:operationId/start|http
POST|/plugins/terminal/analysis/:operationId/stop|http
POST|/plugins/terminal/shell/sessions/:operationId/relaunch|http
POST|/plugins/terminal/shell/ticket|http
PUT|/api/v1/desktop/fullscreen|http
PUT|/api/v1/desktop/shell|http
PUT|/api/v1/settings/global|http
PUT|/api/v1/settings/plugins/:pluginId|http
PUT|/plugins/terminal/agent/agent-cli/path|http
PUT|/plugins/terminal/model-auth/providers/:providerId|http
PUT|/plugins/terminal/settings|http
`.trim().split("\n");
const tempDirs: string[] = [];
const servers: ConsoleServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("api catalog", () => {
  it("serves only the frozen, read-only loopback pairing identity", async () => {
    const fixture = await startFixture();
    const exact = await fetch(`${fixture.endpoint}${PAIRING_IDENTITY_PATH.slice(1)}`);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toEqual(PAIRING_IDENTITY);
    expect(exact.headers.get("access-control-allow-origin")).toBeNull();

    const wrongMethod = await fetch(`${fixture.endpoint}${PAIRING_IDENTITY_PATH.slice(1)}`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);
    await expect(wrongMethod.json()).resolves.toEqual({ error: "Method not allowed" });

    await expect(requestWithHost(fixture.endpoint, PAIRING_IDENTITY_PATH, "localhost:1")).resolves.toEqual({ status: 403, body: { error: "host_mismatch" } });
  });
  it("serializes only the public route catalog DTO", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.endpoint}api/v1/settings/api-catalog`);
    const body = await response.json() as ApiCatalogResponse;
    const serializedRoutes = JSON.stringify(body.routes);

    expect(response.status).toBe(200);
    expect(body.version).toBe("test");
    expect(body.routes).toHaveLength(146);
    expect(body.routes).toEqual(expect.arrayContaining(buildApiCatalog()));
    const identities = body.routes.map(apiCatalogIdentity);
    expect(identities.slice().sort()).toEqual(EXPECTED_API_CATALOG_IDENTITIES);
    expect(new Set(identities).size).toBe(body.routes.length);
    for (const entry of body.routes) {
      expect(Object.keys(entry).sort()).toEqual(ALLOWED_ROUTE_KEYS);
      expect(entry.path).toMatch(/^\//);
      expect(entry.summary).toBeTruthy();
      expect(entry.category).toBeTruthy();
    }
    expect(serializedRoutes).not.toContain(fixture.lock.token);
    expect(serializedRoutes).not.toContain(fixture.fleetDataDir);
    expect(serializedRoutes).not.toContain("handler");
    expect(serializedRoutes).not.toContain("function");
    expect(serializedRoutes).not.toContain("filePath");
    expect(serializedRoutes).not.toContain(".ts");
  });

  it("keeps every catalog path backed by a live server route", async () => {
    const fixture = await startFixture();
    const catalogResponse = await fetch(`${fixture.endpoint}api/v1/settings/api-catalog`);
    const catalog = (await catalogResponse.json() as ApiCatalogResponse).routes;

    for (const entry of catalog) {
      if (entry.transport === "websocket") continue;
      const response = await requestCatalogEntry(fixture, entry);
      await expectCatalogEntryBacked(entry, response);
    }
  });

  it("rejects a generic fallback 404 for a parameterized catalog path", async () => {
    const entry = buildApiCatalog().find((candidate) => candidate.path === "/api/v1/operations/:operationId")!;
    const fallback = new Response(JSON.stringify({ error: "Not found" }), { status: 404 });

    await expect(expectCatalogEntryBacked(entry, fallback)).rejects.toThrow("returned the generic fallback 404");
  });

  it("rejects duplicate method, path, and transport identities", () => {
    const duplicate: ApiCatalogEntry = {
      method: "GET",
      path: "/duplicate",
      summary: "First duplicate.",
      category: "Test",
      gate: "loopback",
      transport: "http",
    };
    expect(() => buildApiCatalog([duplicate, { ...duplicate, summary: "Second duplicate." }])).toThrow("duplicate_api_catalog_entry");
  });

  it("lists the loopback system-font route without scanning the developer machine", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.endpoint}api/v1/settings/fonts/system`);
    const body = await response.json() as { readonly version: number; readonly fonts: unknown[] };

    expect(buildApiCatalog()).toContainEqual(expect.objectContaining({ method: "GET", path: SYSTEM_FONTS_PATH, gate: "loopback" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ version: 1, fonts: INJECTED_SYSTEM_FONTS });
    expect(JSON.stringify(body)).not.toContain(fixture.fleetDataDir);
    expect(JSON.stringify(body)).not.toContain("postScriptName");
  });

  it("denies the system-font route when the loopback Host check fails", async () => {
    const fixture = await startFixture();
    const response = await requestWithHost(fixture.endpoint, SYSTEM_FONTS_PATH, "localhost:1");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "host_mismatch" });
  });
});

async function startFixture(): Promise<ServerFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-api-catalog-"));
  const fleetDataDir = path.join(dir, "fleet-home");
  tempDirs.push(dir);
  const lockFile = path.join(dir, "console.lock");
  const server = createConsoleServer({
    port: 0,
    version: "test",
    agentRuntime: createFakeConsoleRuntime() as never,
    dataDir: fleetDataDir,
    pluginHomeDir: path.join(dir, "home"),
    systemFonts: createInjectedSystemFontsService(),
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile });
  const lock = createConsoleLock().readLock(lockFile)!;
  return { dir, fleetDataDir, lockFile, server, endpoint, lock };
}

function createInjectedSystemFontsService(): SystemFontsService {
  return { getFonts: async () => INJECTED_SYSTEM_FONTS };
}

function createFakeConsoleRuntime(): FakeConsoleRuntime {
  return { cleanup: vi.fn(async () => undefined) };
}

function apiCatalogIdentity(entry: ApiCatalogEntry): string {
  return `${entry.method}|${entry.path}|${entry.transport}`;
}

function requestCatalogEntry(fixture: ServerFixture, entry: ApiCatalogEntry): Promise<Response> {
  const method = entry.method === "*" ? "GET" : entry.method;
  return fetch(`${fixture.endpoint}${concretizeCatalogPath(entry.path).replace(/^\//, "")}`, {
    method,
    headers: headersForGate(entry.gate),
  });
}

async function expectCatalogEntryBacked(entry: ApiCatalogEntry, response: Response): Promise<void> {
  const identity = `${entry.method} ${entry.path}`;
  if (response.status !== 404) {
    await response.body?.cancel();
    expect(response.status, identity).not.toBe(404);
    return;
  }

  if (!entry.path.includes(":")) {
    await response.body?.cancel();
    expect(response.status, identity).not.toBe(404);
    return;
  }

  const body = await response.text();
  expect(isRouteSpecificNotFoundBody(body), `${identity} returned the generic fallback 404`).toBe(true);
}

function isRouteSpecificNotFoundBody(body: string): boolean {
  if (body.trim() === "") return false;
  try {
    const parsed = JSON.parse(body) as unknown;
    return !(
      typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      && Object.keys(parsed).length === 1
      && "error" in parsed
      && parsed.error === "Not found"
    );
  } catch {
    return true;
  }
}

function concretizeCatalogPath(routePath: string): string {
  return routePath
    .replaceAll(":sessionId", "missing-session")
    .replaceAll(":operationId", "missing-operation")
    .replaceAll(":groupId", "missing-group")
    .replaceAll(":artifactId", "missing-artifact")
    .replaceAll(":chatId", "missing-chat")
    .replaceAll(":theaterId", "missing-theater")
    .replaceAll(":pluginId", "terminal")
    .replaceAll(":id", "missing-id")
    .replaceAll(":cliType", "claude")
    .replaceAll(":cli", "claude")
    .replace(/:[^/]+/g, "missing-id");
}

function headersForGate(gate: ApiCatalogEntry["gate"]): Record<string, string> {
  if (gate === "origin-write" || gate === "origin-strict") return { Origin: "http://127.0.0.1:1" };
  if (gate === "lock-token") return {};
  return {};
}

function requestWithHost(endpoint: string, pathname: string, host: string): Promise<HostDeniedResponse> {
  const target = new URL(`${endpoint}${pathname.replace(/^\//, "")}`);
  return new Promise((resolve, reject) => {
    const request = http.request(target, { headers: { host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }));
    });
    request.on("error", reject);
    request.end();
  });
}
