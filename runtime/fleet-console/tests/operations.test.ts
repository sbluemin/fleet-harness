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
  it("creates, moves, renames, lists children, and deletes OperationNodes", () => {
    const store = createOperationStore({ now: () => 10 });
    const parent = store.create({ id: "parent", theaterId: "theater", type: "agent", pluginId: "terminal", title: "Agent" });
    const child = store.create({ id: "child", theaterId: "theater", parentId: parent.id, type: "stream", pluginId: "terminal", title: "Stream" });
    const renamed = store.patch(child.id, { title: "Renamed Stream" });

    expect(store.listByTheater("theater")).toHaveLength(2);
    expect(store.listChildren("theater", parent.id)).toEqual([renamed]);
    expect(renamed?.renamedTitle).toBe("Renamed Stream");

    store.delete(parent.id);

    expect(store.list()).toEqual([]);
  });

  it("enforces depth two for operation trees", () => {
    const store = createOperationStore({ now: () => 10 });
    store.create({ id: "parent", theaterId: "theater", type: "agent", pluginId: "terminal", title: "Agent" });
    store.create({ id: "child", theaterId: "theater", parentId: "parent", type: "stream", pluginId: "terminal", title: "Stream" });

    expect(() => {
      store.create({ id: "grandchild", theaterId: "theater", parentId: "child", type: "leaf", pluginId: "terminal", title: "Leaf" });
    }).toThrow("operation_depth_exceeded");
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

  it("rejects forbidden browser readback payload keys in the SDK validator", () => {
    const base = makeNode({ id: "safe", payload: { visible: "ok" } });

    expect(assertOperationNode(base).id).toBe("safe");
    for (const key of ["cwd", "canonicalCwd", "providerSession", "ticket", "token", "transcriptPath", "prompt", "persona", "toolAllowlist"]) {
      expect(() => assertOperationNode({ ...base, payload: { nested: { [key]: "secret" } } })).toThrow("Invalid operation response");
    }
  });

  it("applies plugin-declared sensitive fields to every operations router DTO", async () => {
    const store = createOperationStore({ now: () => 10 });
    store.create(makeOperation({ id: "parent", payload: { pluginSecret: "parent-secret", visible: "parent" } }));
    store.create(makeOperation({ id: "child", parentId: "parent", payload: { pluginSecret: "child-secret", visible: "child" } }));
    let requestBody: unknown = null;
    const router = createOperationsRouter({
      store,
      isAuthorized: () => true,
      readJsonBody: async <T>() => requestBody as T | null,
      writeJson: (res, status, payload) => {
        Object.assign(res, { status, payload });
      },
      persist: () => {},
      getPluginSensitiveFields: (pluginId) => (pluginId === "terminal" ? ["pluginSecret"] : []),
    });

    const list = await dispatch(router, "GET", "/api/v1/operations");
    const children = await dispatch(router, "GET", "/api/v1/operations/parent/children");
    const item = await dispatch(router, "GET", "/api/v1/operations/parent");
    requestBody = {
      theaterId: "theater",
      type: "agent",
      pluginId: "terminal",
      title: "Created",
      payload: { pluginSecret: "created-secret", visible: "created" },
    };
    const created = await dispatch(router, "POST", "/api/v1/operations");
    requestBody = {
      payload: {
        pluginSecret: "patched-secret",
        visible: "patched",
      },
    };
    const patched = await dispatch(router, "PATCH", "/api/v1/operations/parent");
    const serialized = JSON.stringify([list, children, item, created, patched]);

    expect(serialized).toContain("parent");
    expect(serialized).toContain("child");
    expect(serialized).toContain("created");
    expect(serialized).toContain("patched");
    expect(serialized).not.toContain("parent-secret");
    expect(serialized).not.toContain("child-secret");
    expect(serialized).not.toContain("created-secret");
    expect(serialized).not.toContain("patched-secret");
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
    const catalog = await response.json() as { readonly plugins: ReadonlyArray<{ readonly id: string; readonly title: string; readonly kinds: ReadonlyArray<{ readonly id: string; readonly type: string; readonly title: string }> }> };
    const terminal = catalog.plugins.find((plugin) => plugin.id === "terminal");

    expect(response.status).toBe(200);
    expect(terminal).toEqual({
      id: "terminal",
      title: "Terminal",
      kinds: [
        { id: "shell", type: "shell", title: "Shell" },
        { id: "agent", type: "agent", title: "Agent CLI" },
      ],
    });
    expect(catalog.plugins.filter((plugin) => plugin.id === "terminal")).toHaveLength(1);
  });

  it("deletes every OperationNode for a Theater", () => {
    const store = createOperationStore({ now: () => 10 });
    store.create(makeOperation({ id: "theater-a-parent", theaterId: "theater-a" }));
    store.create(makeOperation({ id: "theater-a-child", theaterId: "theater-a", parentId: "theater-a-parent" }));
    store.create(makeOperation({ id: "theater-b", theaterId: "theater-b" }));

    expect(store.deleteByTheater("theater-a")).toBe(2);

    expect(store.list().map((node) => node.id)).toEqual(["theater-b"]);
  });

  it("drops invalid restored OperationNodes that violate parent or depth constraints", () => {
    const store = createOperationStore({ now: () => 10 });

    store.replace([
      makeNode({ id: "valid-root" }),
      makeNode({ id: "valid-child", parentId: "valid-root" }),
      makeNode({ id: "missing-parent", parentId: "missing" }),
      makeNode({ id: "wrong-theater-parent", theaterId: "other" }),
      makeNode({ id: "wrong-theater-child", parentId: "wrong-theater-parent" }),
      makeNode({ id: "too-deep", parentId: "valid-child" }),
      makeNode({ id: "cycle-a", parentId: "cycle-b" }),
      makeNode({ id: "cycle-b", parentId: "cycle-a" }),
    ]);

    expect(store.list().map((node) => node.id).sort()).toEqual(["valid-child", "valid-root", "wrong-theater-parent"]);
  });
});

function makeNode(input: Partial<OperationNode> = {}): OperationNode {
  return {
    id: input.id ?? "op",
    theaterId: input.theaterId ?? "theater",
    parentId: input.parentId ?? null,
    type: input.type ?? "agent",
    pluginId: input.pluginId ?? "terminal",
    title: input.title ?? "Agent",
    payload: input.payload ?? {},
    geometry: input.geometry ?? null,
    state: input.state ?? {},
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
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.geometry !== undefined ? { geometry: input.geometry } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
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
    "    { id: 'agent', type: 'agent', title: 'Agent CLI' },",
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
