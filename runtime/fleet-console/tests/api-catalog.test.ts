import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { initStore, resetStoreForTests } from "@dotobokuri/fleet-carriers";

import { buildApiCatalog, type ApiCatalogEntry } from "../core/host/api-catalog.js";
import type { ConsoleLockPayload } from "../core/host/api-types.js";
import type { AgentCliDetector } from "../../fleet-plugins/terminal/server/agent-api/agent-cli-detect.js";
import { createConsoleLock } from "../core/host/lock.js";
import { createConsoleServer, PAIRING_IDENTITY, PAIRING_IDENTITY_PATH, type ConsoleServer } from "../core/host/server.js";
import type { SystemFontsService } from "../core/host/system-fonts.js";

interface ServerFixture {
  readonly dir: string;
  readonly carrierStoreDir: string;
  readonly lockFile: string;
  readonly server: ConsoleServer;
  readonly endpoint: string;
  readonly lock: ConsoleLockPayload;
}

interface FakeConsoleRuntime {
  readonly carrierRuntime: {
    readonly jobs: {
      readonly streaming: {
        register(callback: (event: unknown) => void): () => void;
      };
    };
  };
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

const ALLOWED_ROUTE_KEYS = ["method", "path", "summary", "category", "gate"].sort();
const SYSTEM_FONTS_PATH = "/api/v1/settings/fonts/system";
const INJECTED_SYSTEM_FONTS = [{ family: "Noto Sans", monospace: false, uiSuitable: true }];
const tempDirs: string[] = [];
const servers: ConsoleServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  resetStoreForTests();
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
    expect(body.routes).toEqual(buildApiCatalog());
    expect(body.routes.length).toBeGreaterThan(0);
    for (const entry of body.routes) {
      expect(Object.keys(entry).sort()).toEqual(ALLOWED_ROUTE_KEYS);
      expect(entry.path).toMatch(/^\//);
      expect(entry.summary).toBeTruthy();
      expect(entry.category).toBeTruthy();
    }
    expect(serializedRoutes).not.toContain(fixture.lock.token);
    expect(serializedRoutes).not.toContain(fixture.carrierStoreDir);
    expect(serializedRoutes).not.toContain("handler");
    expect(serializedRoutes).not.toContain("function");
    expect(serializedRoutes).not.toContain("filePath");
    expect(serializedRoutes).not.toContain("providerId");
    expect(serializedRoutes).not.toContain(".ts");
  });

  it("keeps every catalog path backed by a live server route", async () => {
    const fixture = await startFixture();
    const catalog = buildApiCatalog();

    for (const entry of catalog) {
      const response = await requestCatalogEntry(fixture, entry);
      await response.body?.cancel();
      expect(response.status, `${entry.method} ${entry.path}`).not.toBe(404);
    }
  });

  it("registers the complete Workspace Preset route table", () => {
    expect(buildApiCatalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "GET", path: "/api/v1/theaters/:theaterId/workspace-presets", gate: "loopback" }),
      expect.objectContaining({ method: "POST", path: "/api/v1/theaters/:theaterId/workspace-presets", gate: "origin-write" }),
      expect.objectContaining({ method: "PATCH", path: "/api/v1/theaters/:theaterId/workspace-presets/:presetId", gate: "origin-write" }),
      expect.objectContaining({ method: "DELETE", path: "/api/v1/theaters/:theaterId/workspace-presets/:presetId", gate: "origin-write" }),
      expect.objectContaining({ method: "POST", path: "/api/v1/theaters/:theaterId/workspace-presets/:presetId/apply", gate: "origin-write" }),
    ]));
  });

  it("lists the loopback system-font route without scanning the developer machine", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.endpoint}api/v1/settings/fonts/system`);
    const body = await response.json() as { readonly version: number; readonly fonts: unknown[] };

    expect(buildApiCatalog()).toContainEqual(expect.objectContaining({ method: "GET", path: SYSTEM_FONTS_PATH, gate: "loopback" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ version: 1, fonts: INJECTED_SYSTEM_FONTS });
    expect(JSON.stringify(body)).not.toContain(fixture.carrierStoreDir);
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
  const carrierStoreDir = path.join(dir, "fleet-home");
  initStore(carrierStoreDir);
  tempDirs.push(dir);
  const lockFile = path.join(dir, "console.lock");
  const server = createConsoleServer({
    port: 0,
    version: "test",
    agentRuntime: createFakeConsoleRuntime() as never,
    agentCliDetector: createStubAgentCliDetector(),
    dataDir: carrierStoreDir,
    systemFonts: createInjectedSystemFontsService(),
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile });
  const lock = createConsoleLock().readLock(lockFile)!;
  return { dir, carrierStoreDir, lockFile, server, endpoint, lock };
}

function createInjectedSystemFontsService(): SystemFontsService {
  return { getFonts: async () => INJECTED_SYSTEM_FONTS };
}

function createStubAgentCliDetector(): AgentCliDetector {
  return {
    detect: async () => [
      { id: "claude", displayName: "Claude Code", available: true, version: null },
      { id: "codex", displayName: "Codex CLI", available: true, version: null },
      { id: "opencode", displayName: "OpenCode", available: true, version: null },
      { id: "cursor-agent", displayName: "Cursor Agent", available: true, version: null },
    ],
  };
}

function createFakeConsoleRuntime(): FakeConsoleRuntime {
  const handlers = new Set<(event: unknown) => void>();
  return {
    carrierRuntime: {
      jobs: {
        streaming: {
          register(callback) {
            handlers.add(callback);
            return () => handlers.delete(callback);
          },
        },
      },
    },
    cleanup: vi.fn(async () => undefined),
  };
}

function requestCatalogEntry(fixture: ServerFixture, entry: ApiCatalogEntry): Promise<Response> {
  const method = entry.method === "*" ? "GET" : entry.method;
  return fetch(`${fixture.endpoint}${concretizeCatalogPath(entry.path).replace(/^\//, "")}`, {
    method,
    headers: headersForGate(entry.gate),
  });
}

function concretizeCatalogPath(routePath: string): string {
  return routePath
    .replaceAll(":sessionId", "missing-session")
    .replaceAll(":theaterId", "missing-theater")
    .replaceAll(":pluginId", "terminal")
    .replaceAll(":id", "missing-carrier")
    .replaceAll(":cliType", "claude")
    .replaceAll(":cli", "claude");
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
