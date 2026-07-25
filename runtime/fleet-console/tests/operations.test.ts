import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertOperationNode } from "@fleet-console/sdk/operations/browser";
import { createConsoleLock } from "../core/host/lock.js";
import { createOperationsRouter } from "../core/host/operations/routes.js";
import { createSanitizedOpDto } from "../core/host/operations/sanitize.js";
import { createOperationStore } from "../core/host/operations/store.js";
import { createConsoleServer, type ConsoleServer, type ConsoleServerDeps } from "../core/host/server.js";
import type { OperationCreateInput, OperationNode } from "../core/host/operations/types.js";

const tempDirs: string[] = [];
const servers: ConsoleServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("operations platform", () => {
  it("creates, renames, and deletes OperationNodes", () => {
    const store = createOperationStore({ now: () => 10 });
    const op = store.create({ id: "op", theaterId: "theater", type: "agent", pluginId: "terminal", title: "Agent" });
    const renamed = store.patch(op.id, { title: "Renamed" });

    expect(store.listByTheater("theater")).toHaveLength(1);
    expect(renamed?.title).toBe("Renamed");

    store.delete(op.id);

    expect(store.list()).toEqual([]);
  });

  it("strips fixed and plugin-declared sensitive fields from browser DTOs fail-closed", () => {
    const store = createOperationStore({ now: () => 10 });
    const node = store.create({
      id: "op",
      theaterId: "theater",
      type: "agent",
      pluginId: "terminal",
      title: "Agent",
      payload: {
        cwd: "/secret",
        canonicalCwd: "/secret",
        providerSession: { sessionId: "provider-secret" },
        providerTitle: { source: "provider" },
        ticket: "ticket-secret",
        token: "token-secret",
        transcriptPath: "/secret/transcript.jsonl",
        prompt: "secret prompt",
        persona: "secret persona",
        toolAllowlist: ["secret-tool"],
        pluginSecret: "plugin-secret",
        visible: "ok",
      },
    });

    const serialized = JSON.stringify(createSanitizedOpDto(node, { sensitiveFields: ["pluginSecret"] }));

    expect(serialized).toContain("visible");
    expect(serialized).not.toContain("/secret");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("ticket-secret");
    expect(serialized).not.toContain("token-secret");
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("secret persona");
    expect(serialized).not.toContain("secret-tool");
    expect(serialized).not.toContain("plugin-secret");
  });

  it("derives a non-sensitive resumeAvailable marker when providerSession is stripped", () => {
    const store = createOperationStore({ now: () => 10 });
    const resumable = store.create({
      id: "op-resumable",
      theaterId: "theater",
      type: "agent",
      pluginId: "terminal",
      title: "Agent",
      payload: { providerSession: { sessionId: "provider-secret" } },
    });
    const plain = store.create({
      id: "op-plain",
      theaterId: "theater",
      type: "shell",
      pluginId: "terminal",
      title: "Shell",
      payload: {},
    });

    const resumableDto = createSanitizedOpDto(resumable);
    const plainDto = createSanitizedOpDto(plain);

    expect(resumableDto.payload?.resumeAvailable).toBe(true);
    expect(JSON.stringify(resumableDto)).not.toContain("provider-secret");
    expect(plainDto.payload?.resumeAvailable).toBeUndefined();
  });

  it("strips a caller-supplied resumeAvailable marker so only the host derives it", () => {
    const store = createOperationStore({ now: () => 10 });
    const spoofed = store.create({
      id: "op-spoofed",
      theaterId: "theater",
      type: "agent",
      pluginId: "terminal",
      title: "Agent",
      payload: { resumeAvailable: true },
    });

    expect(createSanitizedOpDto(spoofed).payload?.resumeAvailable).toBeUndefined();
  });

  it("rejects forbidden browser readback payload keys in the SDK validator", () => {
    const base = makeNode({ id: "safe", payload: { visible: "ok" } });

    expect(assertOperationNode(base).id).toBe("safe");
    for (const key of ["cwd", "canonicalCwd", "providerSession", "ticket", "token", "transcriptPath", "prompt", "persona", "toolAllowlist"]) {
      expect(() => assertOperationNode({ ...base, payload: { nested: { [key]: "secret" } } })).toThrow("Invalid operation response");
    }
  });

  it("applies plugin-declared sensitive fields to every operations router DTO", async () => {
    const store = createOperationStore({ now: () => 10 });
    store.create(makeOperation({ id: "op-a", payload: { pluginSecret: "a-secret", visible: "a" } }));
    let requestBody: unknown = null;
    const router = createOperationsRouter({
      store,
      isAuthorized: () => true,
      readJsonBody: async <T>() => requestBody as T | null,
      writeJson: (res, status, payload) => {
        Object.assign(res, { status, payload });
      },
      persist: () => {},
      deleteOperation: (id) => store.delete(id),
      getPluginSensitiveFields: (pluginId) => (pluginId === "terminal" ? ["pluginSecret", "providerTitle"] : []),
    });

    const list = await dispatch(router, "GET", "/api/v1/operations");
    const item = await dispatch(router, "GET", "/api/v1/operations/op-a");
    requestBody = {
      theaterId: "theater",
      type: "agent",
      pluginId: "terminal",
      title: "Created",
      payload: { pluginSecret: "created-secret", providerTitle: { source: "provider" }, visible: "created" },
    };
    const created = await dispatch(router, "POST", "/api/v1/operations");
    requestBody = {
      payload: {
        pluginSecret: "patched-secret",
        providerTitle: { source: "provider" },
        visible: "patched",
      },
    };
    const patched = await dispatch(router, "PATCH", "/api/v1/operations/op-a");
    const serialized = JSON.stringify([list, item, created, patched]);

    expect(serialized).toContain("op-a");
    expect(serialized).toContain("created");
    expect(serialized).toContain("patched");
    expect(serialized).not.toContain("a-secret");
    expect(serialized).not.toContain("created-secret");
    expect(serialized).not.toContain("patched-secret");
    expect(serialized).not.toContain("providerTitle");
  });

  it("sets, preserves, and clears operation accent through PATCH", async () => {
    const store = createOperationStore({ now: () => 10 });
    store.create({ id: "op", theaterId: "theater", type: "agent", pluginId: "terminal", title: "Agent", accent: "sky" });
    let requestBody: unknown = null;
    const router = createOperationsRouter({
      store,
      isAuthorized: () => true,
      readJsonBody: async <T>() => requestBody as T | null,
      writeJson: (res, status, payload) => {
        Object.assign(res, { status, payload });
      },
      persist: () => {},
      deleteOperation: (id) => store.delete(id),
    });

    requestBody = { accent: "blue" };
    await dispatch(router, "PATCH", "/api/v1/operations/op");
    expect(store.get("op")?.accent).toBe("blue");

    // accent 생략(undefined) → 무변경
    requestBody = { title: "Renamed" };
    await dispatch(router, "PATCH", "/api/v1/operations/op");
    expect(store.get("op")?.accent).toBe("blue");

    // accent: null → 해제(geometry null-clear 계약과 동일)
    requestBody = { accent: null };
    await dispatch(router, "PATCH", "/api/v1/operations/op");
    expect(store.get("op")?.accent).toBeUndefined();

    // 문자열·null 외 타입 → 400 거부, 상태 불변
    requestBody = { accent: 42 };
    const rejected = await dispatch(router, "PATCH", "/api/v1/operations/op");
    expect(rejected).toEqual({ error: "invalid_operation_accent" });
    expect(store.get("op")?.accent).toBeUndefined();
  });

  it("serves the operation launch catalog before item routes", async () => {
    const store = createOperationStore({ now: () => 10 });
    const router = createOperationsRouter({
      store,
      isAuthorized: () => false,
      readJsonBody: async <T>() => null as T | null,
      writeJson: (res, status, payload) => {
        Object.assign(res, { status, payload });
      },
      persist: () => {},
      deleteOperation: (id) => store.delete(id),
      resolveLaunchCatalog: async () => ({
        plugins: [
          {
            id: "shell",
            title: "Shell",
            kinds: [{ id: "shell", type: "shell", title: "Shell" }],
          },
        ],
      }),
    });

    const catalog = await dispatch(router, "GET", "/api/v1/operations/catalog");
    const rejected = await dispatch(router, "POST", "/api/v1/operations/catalog");

    expect(catalog).toEqual({
      plugins: [
        {
          id: "shell",
          title: "Shell",
          kinds: [{ id: "shell", type: "shell", title: "Shell" }],
        },
      ],
    });
    expect(rejected).toEqual({ error: "Method not allowed" });
  });

  it("concats multiple launch catalog providers for one plugin group", async () => {
    const fixture = await startCatalogFixture();

    const response = await fetch(`${fixture.endpoint}api/v1/operations/catalog`);
    const catalog = await response.json() as { readonly plugins: ReadonlyArray<{ readonly id: string; readonly title: string; readonly kinds: ReadonlyArray<{ readonly id: string; readonly type: string; readonly title: string; readonly supportsInitialPrompt?: boolean }> }> };
    const terminal = catalog.plugins.find((plugin) => plugin.id === "terminal");

    expect(response.status).toBe(200);
    expect(terminal).toEqual({
      id: "terminal",
      title: "Terminal",
      kinds: [
        { id: "shell", type: "shell", title: "Shell" },
        { id: "agent", type: "agent", title: "Agent CLI", supportsInitialPrompt: true },
      ],
    });
    expect(catalog.plugins.filter((plugin) => plugin.id === "terminal")).toHaveLength(1);
  });

  it("deletes every OperationNode for a Theater", () => {
    const store = createOperationStore({ now: () => 10 });
    store.create(makeOperation({ id: "theater-a-1", theaterId: "theater-a" }));
    store.create(makeOperation({ id: "theater-a-2", theaterId: "theater-a" }));
    store.create(makeOperation({ id: "theater-b", theaterId: "theater-b" }));

    expect(store.deleteByTheater("theater-a")).toBe(2);

    expect(store.list().map((node) => node.id)).toEqual(["theater-b"]);
  });

  it("deduplicates restored OperationNodes by id", () => {
    const store = createOperationStore({ now: () => 10 });

    store.replace([
      makeNode({ id: "op-a" }),
      makeNode({ id: "op-a" }),
      makeNode({ id: "op-b" }),
    ]);

    expect(store.list().map((node) => node.id).sort()).toEqual(["op-a", "op-b"]);
  });
});

function makeNode(input: Partial<OperationNode> = {}): OperationNode {
  return {
    id: input.id ?? "op",
    theaterId: input.theaterId ?? "theater",
    type: input.type ?? "agent",
    pluginId: input.pluginId ?? "terminal",
    title: input.title ?? "Agent",
    payload: input.payload ?? {},
    geometry: input.geometry ?? null,
    ts: input.ts ?? { createdAt: 10, updatedAt: 10 },
  };
}

function makeOperation(input: Partial<OperationCreateInput> = {}): OperationCreateInput {
  return {
    id: input.id ?? "op",
    theaterId: input.theaterId ?? "theater",
    type: input.type ?? "agent",
    pluginId: input.pluginId ?? "terminal",
    title: input.title ?? "Agent",
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.geometry !== undefined ? { geometry: input.geometry } : {}),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
  };
}

async function dispatch(router: ReturnType<typeof createOperationsRouter>, method: string, pathname: string): Promise<unknown> {
  const res = {};
  await router({
    req: { method, url: pathname } as never,
    res: res as never,
    pathname,
  });
  return (res as { readonly payload?: unknown }).payload;
}

async function startCatalogFixture(): Promise<{ readonly endpoint: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-catalog-"));
  tempDirs.push(dir);
  const packageRoot = path.join(dir, "runtime", "fleet-console");
  const pluginsRoot = path.join(dir, "runtime", "fleet-plugins");
  const dataDir = path.join(dir, "fleet-home");
  const lockFile = path.join(dir, "console.lock");
  fs.mkdirSync(packageRoot, { recursive: true });
  writeTestPlugin(path.join(pluginsRoot, "terminal"), "terminal", "Terminal", [
    "export function register(ctx) {",
    "  ctx.host.operations.registerLaunchCatalog(ctx.pluginId, () => [",
    "    { id: 'shell', type: 'shell', title: 'Shell', cwd: '/secret' },",
    "  ]);",
    "  ctx.host.operations.registerLaunchCatalog(ctx.pluginId, () => [",
    "    { id: 'shell', type: 'ignored-duplicate', title: 'Ignored Duplicate' },",
    "    { id: 'agent', type: 'agent', title: 'Agent CLI', supportsInitialPrompt: true },",
    "  ]);",
    "}",
  ].join("\n"));
  const server = createConsoleServer({
    port: 0,
    version: "test",
    dataDir,
    release: { channel: "local", version: "test", packageRoot } satisfies ConsoleServerDeps["release"],
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile });
  expect(createConsoleLock().readLock(lockFile)).not.toBeNull();
  return { endpoint };
}

function writeTestPlugin(pluginRoot: string, id: string, name: string, routes: string): void {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify({ id, name, routes: "routes.mjs" }));
  fs.writeFileSync(path.join(pluginRoot, "routes.mjs"), routes);
}
