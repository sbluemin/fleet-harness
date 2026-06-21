import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { initStore, resetStoreForTests } from "@dotobokuri/fleet-carriers";

import { buildApiCatalog, type ApiCatalogEntry } from "../src/api-catalog.js";
import type { ConsoleLockPayload } from "../src/api-types.js";
import type { AgentCliDetector } from "../src/agent-cli-detect.js";
import { createConsoleLock } from "../src/lock.js";
import { createConsoleServer, type ConsoleServer } from "../src/server.js";

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

const ALLOWED_ROUTE_KEYS = ["method", "path", "summary", "category", "gate"].sort();
const tempDirs: string[] = [];
const servers: ConsoleServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  resetStoreForTests();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("api catalog", () => {
  it("serializes only the public route catalog DTO", async () => {
    const fixture = await startFixture();
    const response = await fetch(`${fixture.endpoint}observer/api-catalog`);
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
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile });
  const lock = createConsoleLock().readLock(lockFile)!;
  return { dir, carrierStoreDir, lockFile, server, endpoint, lock };
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
    .replaceAll(":id", "missing-carrier")
    .replaceAll(":cliType", "claude")
    .replaceAll(":cli", "claude-kimi");
}

function headersForGate(gate: ApiCatalogEntry["gate"]): Record<string, string> {
  if (gate === "terminal-origin" || gate === "console-origin") return { Origin: "http://127.0.0.1:1" };
  if (gate === "lock-token") return {};
  return {};
}
