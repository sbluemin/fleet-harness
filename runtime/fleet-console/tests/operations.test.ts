import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import { assertOperationNode, fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import { readLaunchVariantGroups } from "@fleet-console/sdk/operations/launch-variants";
import { readConsoleLockFile } from "@fleet-console/lifecycle";
import { CORE_AGENT_SENSITIVE_FIELDS } from "../core/host/bootstrap/execution.js";
import { createOperationsRouter } from "../features/execution/host/operations/operations-domain.js";
import { createSanitizedOpDto } from "../features/execution/host/operations/operations-domain.js";
import { createOperationStore } from "../features/execution/host/operations/operations-domain.js";
import { createConsoleServer, type ConsoleServer, type ConsoleServerDeps } from "../core/host/bootstrap/server.js";
import type { OperationCreateInput, OperationNode } from "../features/execution/host/operations/operations-domain.js";

const tempDirs: string[] = [];
const servers: ConsoleServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("operations platform", () => {
  it("creates, renames, and deletes OperationNodes", () => {
    const store = createOperationStore({ now: () => 10 });
    const op = store.create({ id: "op", theaterId: "theater", type: "agent", pluginId: "terminal", title: "Agent", payload: { launchedBy: { kind: "plugin", pluginId: "objectives" } } });
    const renamed = store.patch(op.id, { title: "Renamed" });

    expect(store.listByTheater("theater")).toHaveLength(1);
    expect(renamed?.title).toBe("Renamed");
    expect(store.list()[0]).not.toHaveProperty("childSessions");

    const childId = "22222222-2222-4222-8222-222222222222";
    const child = store.createChild({ parentOperationId: op.id, childSessionId: childId, payload: { session: { sessionName: "objective-member-1" } } });
    expect(child.title).toBe("objective-member-1");
    expect(store.createChild({ parentOperationId: op.id, childSessionId: childId })).toEqual(child);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.childSessions?.map((entry) => entry.id)).toEqual([childId]);
    expect(store.list()[0]).not.toHaveProperty("parentOperationId");
    expect(() => store.create(makeOperation({ id: childId }))).toThrow("operation_exists");
    store.create(makeOperation({ id: "other" }));
    expect(() => store.createChild({ parentOperationId: "other", childSessionId: childId })).toThrow("operation_exists");
    expect(() => store.patch(childId, { title: "not allowed" })).toThrow("invalid_child_patch");
    expect(() => store.deleteChild(childId, "other-plugin")).toThrow("child_delete_forbidden");
    expect(store.get(childId)).not.toBeNull();
    store.deleteChild(childId, "objectives");
    expect(store.list()[0]).not.toHaveProperty("childSessions");

    store.delete(op.id);
    store.delete("other");
    expect(store.list()).toEqual([]);
  });

  it("persists Theater order while ignoring foreign and duplicate IDs", async () => {
    const store = createOperationStore({ now: () => 10 });
    store.create(makeOperation({ id: "a", theaterId: "one", createdAt: 1 }));
    store.create(makeOperation({ id: "b", theaterId: "one", createdAt: 2 }));
    store.create(makeOperation({ id: "foreign", theaterId: "two", createdAt: 3 }));
    const persist = vi.fn();
    const broadcast = vi.fn();
    const router = createOperationsRouter({
      store, isAuthorized: () => true, readJsonBody: async <T,>() => ({ theaterId: "one", operationIds: ["b", "foreign", "b", "missing", "a"] }) as T,
      writeJson: (res, status, payload) => Object.assign(res, { status, payload }), persist,
      deleteOperation: () => null, broadcastOperationChanged: broadcast,
    });
    const res: { status?: number; payload?: { operations: OperationNode[] } } = {};
    await router({ req: { method: "PUT" } as never, res: res as never, pathname: "/api/v1/operations/order" });
    expect(res.status).toBe(200);
    expect(res.payload?.operations.map((op) => [op.id, op.order])).toEqual([["a", 1], ["b", 0]]);
    expect(store.listByTheater("one").map((op) => op.id)).toEqual(["b", "a"]);
    expect(store.get("foreign")?.order).toBeUndefined();
    expect(persist).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(store.reorder("one", ["b"]).map((op) => op.id)).toEqual(["a"]);
    expect(store.get("a")?.order).toBeUndefined();
  });

  it("그룹 API는 hex 색의 생성·수정을 영속화 전에 거절한다", async () => {
    const store = createOperationStore({ now: () => 10 });
    const persist = vi.fn();
    let body: Record<string, unknown> = { theaterId: "one", name: "Alpha", color: "#4f8cff" };
    const router = createOperationsRouter({
      store, isAuthorized: () => true, readJsonBody: async <T,>() => body as T,
      writeJson: (res, status, payload) => Object.assign(res, { status, payload }), persist,
      deleteOperation: () => null,
    });
    const createRes: { status?: number; payload?: unknown } = {};
    await router({ req: { method: "POST" } as never, res: createRes as never, pathname: "/api/v1/operations/groups" });
    expect(createRes).toEqual({ status: 400, payload: { error: "invalid_group_color" } });
    expect(store.listAllGroups()).toEqual([]);
    expect(persist).not.toHaveBeenCalled();

    body = { ...body, color: "blue" };
    const acceptedRes: { status?: number; payload?: { group: { id: string; color: string } } } = {};
    await router({ req: { method: "POST" } as never, res: acceptedRes as never, pathname: "/api/v1/operations/groups" });
    expect(acceptedRes.status).toBe(201);
    expect(acceptedRes.payload?.group.color).toBe("blue");
    const groupId = acceptedRes.payload!.group.id;
    persist.mockClear();

    body = { color: "#4f8cff" };
    const patchRes: { status?: number; payload?: unknown } = {};
    await router({ req: { method: "PATCH" } as never, res: patchRes as never, pathname: `/api/v1/operations/groups/${groupId}` });
    expect(patchRes).toEqual({ status: 400, payload: { error: "invalid_group_color" } });
    expect(store.listAllGroups()[0]?.color).toBe("blue");
    expect(persist).not.toHaveBeenCalled();

    body = { color: "teal" };
    const updatedRes: { status?: number } = {};
    await router({ req: { method: "PATCH" } as never, res: updatedRes as never, pathname: `/api/v1/operations/groups/${groupId}` });
    expect(updatedRes.status).toBe(200);
    expect(store.listAllGroups()[0]?.color).toBe("teal");
    expect(persist).toHaveBeenCalledOnce();
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

    const serialized = JSON.stringify(createSanitizedOpDto(node, { sensitiveFields: [...CORE_AGENT_SENSITIVE_FIELDS, "pluginSecret"] }));

    expect(serialized).toContain("visible");
    expect(serialized).not.toContain("/secret");
    expect(serialized).not.toContain("internal-plugin");
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
    "    { id: 'agent', type: 'agent', title: 'Agent CLI' },",
    "    {",
    "      id: 'claude', type: 'agent', title: 'Claude', ignored: 'drop-me',",
    "      launchViews: ['terminal', 'chat', 'bogus-surface'],",
    "      variants: [{",
    "        id: 'native', label: 'Claude', rows: [{",
    "          id: 'fable', label: 'Fable', launch: { model: 'fable', invalid: false },",
    "          chips: [{ id: 'max', label: 'MAX', launch: { model: 'fable', effort: 'max', invalid: 7 } }],",
    "        }, { id: 'invalid', label: 'Invalid', launch: { model: false } }],",
    "      }],",
    "    },",
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
  expect(readConsoleLockFile(lockFile)).not.toBeNull();
  return { endpoint };
}

function writeTestPlugin(pluginRoot: string, id: string, name: string, routes: string): void {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify({ id, name, routes: "routes.mjs" }));
  fs.writeFileSync(path.join(pluginRoot, "routes.mjs"), routes);
}
