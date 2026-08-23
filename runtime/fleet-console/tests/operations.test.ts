import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import { assertOperationNode, fetchOperationCatalog } from "@fleet-console/sdk/operations/browser";
import { readLaunchVariantGroups } from "@fleet-console/sdk/operations/launch-variants";
import { createConsoleLock } from "../core/host/lock.js";
import { createOperationsRouter } from "../core/host/operations/operations-domain.js";
import { createSanitizedOpDto } from "../core/host/operations/operations-domain.js";
import { createOperationStore } from "../core/host/operations/operations-domain.js";
import { createConsoleServer, type ConsoleServer, type ConsoleServerDeps } from "../core/host/server.js";
import type { OperationCreateInput, OperationNode } from "../core/host/operations/operations-domain.js";

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
      payload: { session: { harness: "claude-code", id: "provider-secret" } },
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

  it("does not expose Resume for a removed provider's preserved durable session", () => {
    const store = createOperationStore({ now: () => 10 });
    const removedProvider = store.create({
      id: "op-removed-provider",
      theaterId: "theater",
      type: "agent",
      pluginId: "terminal",
      title: "Legacy agent",
      payload: { session: { harness: "codex-cli", id: "provider-secret" } },
    });

    const dto = createSanitizedOpDto(removedProvider);
    expect(dto.payload?.resumeAvailable).toBeUndefined();
    expect(JSON.stringify(dto)).not.toContain("provider-secret");
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

  it("does not derive resumeAvailable from a shapeless session object", () => {
    const store = createOperationStore({ now: () => 10 });
    const shapeless = store.create({
      id: "op-shapeless",
      theaterId: "theater",
      type: "agent",
      pluginId: "terminal",
      title: "Agent",
      payload: { session: {} },
    });
    const valid = store.create({
      id: "op-valid",
      theaterId: "theater",
      type: "agent",
      pluginId: "terminal",
      title: "Agent",
      payload: { session: { harness: "claude-code", id: "provider-secret" } },
    });

    expect(createSanitizedOpDto(shapeless).payload?.resumeAvailable).toBeUndefined();
    expect(createSanitizedOpDto(valid).payload?.resumeAvailable).toBe(true);
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
      deleteOperation: (id) => store.delete(id) ? ({ deletionId: `delete-${id}`, kind: "operation", targetId: id, expiresAt: 8_000 }) : null,
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
      deleteOperation: (id) => store.delete(id) ? ({ deletionId: `delete-${id}`, kind: "operation", targetId: id, expiresAt: 8_000 }) : null,
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

  it("omits all-malformed launch variants and non-boolean starred values", () => {
    expect(readLaunchVariantGroups([
      { id: 7, label: "Bad", rows: [] },
      { id: "empty", label: "Empty", rows: [{ id: "bad", label: "Bad", launch: { model: false } }] },
    ])).toEqual([]);

    expect(readLaunchVariantGroups([{
      id: "native",
      label: "Claude",
      rows: [{ id: "fable", label: "Fable", starred: "yes", launch: { model: "fable" } }],
    }])).toEqual([{
      id: "native",
      label: "Claude",
      rows: [{ id: "fable", label: "Fable", launch: { model: "fable" } }],
    }]);
  });

  it("carries the effort axis through, since the row is rebuilt field by field", () => {
    // 이 함수는 행을 화이트리스트로 다시 짓는다 — 목록에 없는 필드는 오류 없이 사라진다.
    const [group] = readLaunchVariantGroups([{
      id: "gateway:kimi",
      label: "Moonshot-Kimi",
      rows: [{
        id: "kimi--k3",
        label: "K3-1M",
        launch: { model: "kimi--k3" },
        effortAxis: ["low", "medium", "high", "xhigh", "max", "ultra", 7],
        gatedEfforts: ["max", "ultra", 7],
        chips: [{ id: "low", label: "LOW", launch: { model: "kimi--k3", effort: "low" } }],
      }],
    }]);
    expect(group?.rows[0]?.effortAxis).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(group?.rows[0]?.gatedEfforts).toEqual(["max", "ultra"]);

    // 축은 칩이 놓인 자리를 말한다 — 칩이 없으면 말할 자리도 없다.
    const [bare] = readLaunchVariantGroups([{
      id: "gateway:cursor",
      label: "Cursor",
      rows: [{
        id: "cursor--auto",
        label: "Auto",
        launch: { model: "cursor--auto" },
        effortAxis: ["low"],
        gatedEfforts: ["max"],
      }],
    }]);
    expect(bare?.rows[0]).not.toHaveProperty("effortAxis");
    expect(bare?.rows[0]).not.toHaveProperty("gatedEfforts");
  });

  it("strictly reconstructs launch variants from the browser catalog response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      plugins: [{
        id: "terminal",
        title: "Terminal",
        kinds: [
          {
            id: "claude",
            type: "agent",
            title: "Claude",
            variants: [
              {
                id: "native",
                label: "Claude",
                rows: [
                  {
                    id: "fable",
                    label: "Fable",
                    starred: true,
                    ignored: "drop-me",
                    launch: { model: "fable", effort: 5 },
                    chips: [
                      { id: "max", label: "MAX", launch: { model: "fable", effort: "max", extra: false } },
                      { id: 7, label: "HIGH", launch: { model: "fable", effort: "high" } },
                      { id: "empty", label: "EMPTY", launch: { effort: 5 } },
                    ],
                  },
                  { id: "empty", label: "Empty", launch: { model: false } },
                  { id: "missing-label", launch: { model: "opus" } },
                ],
              },
              { id: 8, label: "Malformed", rows: [] },
              { id: "empty", label: "Empty", rows: [{ id: "bad", label: "Bad", launch: [] }] },
            ],
          },
          {
            id: "malformed-variants",
            type: "agent",
            title: "Malformed variants",
            variants: [{ id: "empty", label: "Empty", rows: [{ id: "bad", label: "Bad", launch: { model: false } }] }],
          },
          { id: "shell", type: "shell", title: "Shell" },
        ],
      }],
    })));

    const catalog = await fetchOperationCatalog();

    expect(catalog).toEqual([{
      id: "terminal",
      title: "Terminal",
      kinds: [
        {
          id: "claude",
          type: "agent",
          title: "Claude",
          variants: [{
            id: "native",
            label: "Claude",
            rows: [{
              id: "fable",
              label: "Fable",
              starred: true,
              launch: { model: "fable" },
              chips: [{
                id: "max",
                label: "MAX",
                launch: { model: "fable", effort: "max" },
              }],
            }],
          }],
        },
        { id: "malformed-variants", type: "agent", title: "Malformed variants" },
        { id: "shell", type: "shell", title: "Shell" },
      ],
    }]);
    fetchMock.mockRestore();
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
      deleteOperation: (id) => store.delete(id) ? ({ deletionId: `delete-${id}`, kind: "operation", targetId: id, expiresAt: 8_000 }) : null,
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
        {
          id: "claude",
          type: "agent",
          title: "Claude",
          variants: [{
            id: "native",
            label: "Claude",
            rows: [{
              id: "fable",
              label: "Fable",
              launch: { model: "fable" },
              chips: [{
                id: "max",
                label: "MAX",
                launch: { model: "fable", effort: "max" },
              }],
            }],
          }],
          // 시작 뷰 선언은 이 sanitizer를 지나야 컴포저에 닿는다 — 여기서 떨어지면 소스 테스트가
          // 전부 green인 채로 `/view`만 조용히 사라진다(실제로 그렇게 한 번 놓쳤다).
          // 모르는 표면 이름은 버린다.
          launchViews: ["terminal", "chat"],
        },
      ],
    });
    expect(catalog.plugins.filter((plugin) => plugin.id === "terminal")).toHaveLength(1);
  });

  it("preserves launch variants through the host catalog HTTP sanitizer", async () => {
    const fixture = await startCatalogFixture();

    const response = await fetch(`${fixture.endpoint}api/v1/operations/catalog`);
    const catalog = await response.json() as {
      readonly plugins: ReadonlyArray<{
        readonly id: string;
        readonly kinds: readonly OperationLaunchKind[];
      }>;
    };
    const gateway = catalog.plugins
      .find((plugin) => plugin.id === "terminal")
      ?.kinds.find((kind) => kind.id === "claude");

    expect(response.status).toBe(200);
    expect(gateway).toEqual({
      id: "claude",
      type: "agent",
      title: "Claude",
      variants: [{
        id: "native",
        label: "Claude",
        rows: [{
          id: "fable",
          label: "Fable",
          launch: { model: "fable" },
          chips: [{
            id: "max",
            label: "MAX",
            launch: { model: "fable", effort: "max" },
          }],
        }],
      }],
      launchViews: ["terminal", "chat"],
    });
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
  expect(createConsoleLock().readLock(lockFile)).not.toBeNull();
  return { endpoint };
}

function writeTestPlugin(pluginRoot: string, id: string, name: string, routes: string): void {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify({ id, name, routes: "routes.mjs" }));
  fs.writeFileSync(path.join(pluginRoot, "routes.mjs"), routes);
}
