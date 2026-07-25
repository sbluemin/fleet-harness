import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CLI_BACKENDS, getEffort, getProviderModels, type CliType } from "@dotobokuri/core-unified-agent";
import { initStore, resetStoreForTests } from "@dotobokuri/fleet-carriers";

import type { ConsoleLockPayload } from "../core/host/api-types.js";
import { createConsoleLock } from "../core/host/lock.js";
import { createConsoleServer, type ConsoleServer, type ConsoleServerDeps } from "../core/host/server.js";

interface ServerFixture {
  readonly dir: string;
  readonly carrierStoreDir: string;
  readonly lockFile: string;
  readonly server: ConsoleServer;
  readonly endpoint: string;
  readonly lock: ConsoleLockPayload;
}

interface CarrierSettingsState {
  readonly generation: number;
  readonly carriers: readonly CarrierSettingsCarrier[];
}

interface CarrierSettingsCarrier {
  readonly carrierId: string;
  readonly displayName: string;
  readonly sourceDisplayName: string;
  readonly cliType: string;
  readonly defaultCliType: string;
  readonly model: string;
  readonly effort?: string;
  readonly taskForceCapable: boolean;
  readonly taskforce: {
    readonly backends: ReadonlyArray<{ readonly cliType: string; readonly model: string; readonly effort?: string }>;
  };
}

interface CarrierSettingsOptions {
  readonly cliTypes: ReadonlyArray<{
    readonly id: string;
    readonly models: ReadonlyArray<{ readonly modelId: string; readonly name: string; readonly effort?: { readonly levels: readonly string[]; readonly default: string } }>;
    readonly defaultModel: string;
  }>;
  readonly taskForceConstraints: { readonly minBackends: number };
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

const tempDirs: string[] = [];
const servers: ConsoleServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  resetStoreForTests();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("carrier settings routes", () => {
  it("serves state and options without restricted browser fields", async () => {
    const fixture = await startFixture();
    const state = await getJson<CarrierSettingsState>(`${fixture.endpoint}api/v1/plugins/terminal/carriers`);
    const options = await getJson<CarrierSettingsOptions>(`${fixture.endpoint}api/v1/plugins/terminal/carriers/options`);
    const serialized = JSON.stringify({ state, options });

    expect(state.generation).toBeGreaterThanOrEqual(0);
    expect(state.carriers.length).toBeGreaterThan(0);
    expect(options.taskForceConstraints.minBackends).toBe(2);
    expect(serialized).not.toContain(fixture.lock.token);
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("persona");
    expect(serialized).not.toContain("taskForceBackendCount");
    expect(serialized).not.toContain("toolAllowlist");
    expect(serialized).not.toContain("allowedExecutorTools");
    expect(serialized).not.toContain(fixture.carrierStoreDir);
    const legacy = await fetch(`${fixture.endpoint}api/v1/settings/carriers`);
    expect(legacy.status).toBe(404);
  });

  it("serves provider defaults and model options from the validation registry", async () => {
    const fixture = await startFixture();
    const options = await getJson<CarrierSettingsOptions>(`${fixture.endpoint}api/v1/plugins/terminal/carriers/options`);

    for (const cliType of getCliTypes()) {
      const option = options.cliTypes.find((item) => item.id === cliType);
      const provider = getProviderModels(cliType);
      expect(option?.defaultModel).toBe(provider.defaultModel);
      expect(option?.models.map((model) => ({ modelId: model.modelId, name: model.name }))).toEqual(
        provider.models.map((model) => ({ modelId: model.modelId, name: model.name })),
      );
      for (const model of option?.models ?? []) {
        const effort = getEffort(cliType, model.modelId);
        expect(model.effort).toEqual(effort.supported ? { levels: effort.levels, default: effort.default } : undefined);
      }
    }
  });

  it("uses getEffort defaults for advertised effort options", async () => {
    const fixture = await startFixture();
    const options = await getJson<CarrierSettingsOptions>(`${fixture.endpoint}api/v1/plugins/terminal/carriers/options`);

    for (const cli of options.cliTypes) {
      for (const model of cli.models) {
        const effort = getEffort(cli.id as CliType, model.modelId);
        if (effort.supported) expect(model.effort?.default).toBe(effort.default);
        else expect(model.effort).toBeUndefined();
      }
    }
    const codex = options.cliTypes.find((cli) => cli.id === "codex");
    expect(codex).toBeDefined();
    if (!codex) return;
    const codexDefault = codex.models.find((model) => model.modelId === codex.defaultModel);
    const codexEffort = getEffort("codex", codex.defaultModel);
    expect(codexEffort.supported).toBe(true);
    if (codexEffort.supported) expect(codexDefault?.effort?.default).toBe(codexEffort.default);
  });

  it("rejects mutation requests without terminal origin and JSON content type", async () => {
    const fixture = await startFixture();
    const state = await getJson<CarrierSettingsState>(`${fixture.endpoint}api/v1/plugins/terminal/carriers`);
    const carrier = state.carriers[0]!;

    const wrongOrigin = await fetch(`${fixture.endpoint}api/v1/plugins/terminal/carriers/${carrier.carrierId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:1" },
      body: JSON.stringify({ displayName: "Blocked" }),
    });
    const wrongType = await fetch(`${fixture.endpoint}api/v1/plugins/terminal/carriers/${carrier.carrierId}`, {
      method: "PATCH",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ displayName: "Blocked" }),
    });

    expect(wrongOrigin.status).toBe(401);
    expect(wrongType.status).toBe(415);
  });

  it("initializes the store and persists display name changes to carriers.json", async () => {
    const fixture = await startFixture();
    const state = await getJson<CarrierSettingsState>(`${fixture.endpoint}api/v1/plugins/terminal/carriers`);
    const carrier = state.carriers[0]!;

    const changed = await mutate<{ readonly state: CarrierSettingsState }>(
      fixture,
      `/api/v1/plugins/terminal/carriers/${carrier.carrierId}`,
      "PATCH",
      { displayName: "Console Carrier" },
    );
    const persisted = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "carriers.json"), "utf8")) as { readonly carriers?: Record<string, { readonly displayName?: string }> };
    const reset = await mutate<{ readonly state: CarrierSettingsState }>(
      fixture,
      `/api/v1/plugins/terminal/carriers/${carrier.carrierId}`,
      "PATCH",
      { displayName: carrier.sourceDisplayName },
    );

    expect(changed.state.carriers.find((item) => item.carrierId === carrier.carrierId)?.displayName).toBe("Console Carrier");
    expect(persisted.carriers?.[carrier.carrierId]?.displayName).toBe("Console Carrier");
    expect(reset.state.carriers.find((item) => item.carrierId === carrier.carrierId)?.displayName).toBe(carrier.sourceDisplayName);
  });

  it("validates model and effort combinations server-side", async () => {
    const fixture = await startFixture();
    const state = await getJson<CarrierSettingsState>(`${fixture.endpoint}api/v1/plugins/terminal/carriers`);
    const carrier = state.carriers[0]!;

    const invalid = await rawMutate(fixture, `/api/v1/plugins/terminal/carriers/${carrier.carrierId}`, "PATCH", { model: { model: "missing-model", effort: "max" } });

    expect(invalid.status).toBe(400);
  });

  it("reports Nimitz as Task Force capable and accepts backend PUT through the settings route", async () => {
    const fixture = await startFixture();
    const initial = await getJson<CarrierSettingsState>(`${fixture.endpoint}api/v1/plugins/terminal/carriers`);
    const nimitz = initial.carriers.find((carrier) => carrier.carrierId === "nimitz");
    if (!nimitz) throw new Error("Nimitz was not registered");
    expect(nimitz.taskForceCapable).toBe(true);

    const model = getProviderModels("claude").defaultModel;
    const effort = getEffort("claude", model);
    const updated = await mutate<{ readonly state: CarrierSettingsState }>(
      fixture,
      "/api/v1/plugins/terminal/carriers/nimitz/taskforce/claude",
      "PUT",
      { model, ...(effort.supported ? { effort: effort.default } : {}) },
    );

    expect(updated.state.carriers.find((carrier) => carrier.carrierId === "nimitz")?.taskforce.backends).toEqual([
      { cliType: "claude", model, ...(effort.supported ? { effort: effort.default } : {}) },
    ]);
  });

  it("leaves stale carriers.json Kirov overrides dormant and out of the registry-driven settings UI", async () => {
    const fixture = await startFixture({
      beforeCreateServer: ({ carrierStoreDir }) => {
        fs.mkdirSync(carrierStoreDir, { recursive: true });
        fs.writeFileSync(path.join(carrierStoreDir, "carriers.json"), JSON.stringify({
          _meta: { generation: 9 },
          carriers: {
            kirov: { displayName: "Stale Kirov", agentCliType: "claude" },
            nimitz: { displayName: "Nimitz Override" },
          },
        }));
      },
    });
    const state = await getJson<CarrierSettingsState>(`${fixture.endpoint}api/v1/plugins/terminal/carriers`);
    const persisted = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "carriers.json"), "utf8")) as {
      carriers?: Record<string, unknown>;
    };

    expect(state.carriers.map((carrier) => carrier.carrierId)).toEqual([
      "nimitz",
      "genesis",
      "ohio",
      "sentinel",
      "vanguard",
    ]);
    expect(state.carriers.find((carrier) => carrier.carrierId === "kirov")).toBeUndefined();
    expect(state.carriers.find((carrier) => carrier.carrierId === "nimitz")?.displayName).toBe("Nimitz Override");
    expect(persisted.carriers?.kirov).toEqual({ displayName: "Stale Kirov", agentCliType: "claude" });
  });

  it("keeps stale incapable Task Force settings ineffective, rejects PUT without a write, and permits cleanup", async () => {
    const model = getProviderModels("claude").defaultModel;
    const effort = getEffort("claude", model);
    const fixture = await startFixture({
      beforeCreateServer: ({ carrierStoreDir }) => {
        fs.mkdirSync(carrierStoreDir, { recursive: true });
        fs.writeFileSync(path.join(carrierStoreDir, "carriers.json"), JSON.stringify({
          _meta: { generation: 7 },
          carriers: { genesis: { taskforce: { claude: { model } } } },
        }));
      },
    });
    const initial = await getJson<CarrierSettingsState>(`${fixture.endpoint}api/v1/plugins/terminal/carriers`);
    const genesis = initial.carriers.find((carrier) => carrier.carrierId === "genesis");
    if (!genesis) throw new Error("Genesis was not registered");
    expect(genesis.taskForceCapable).toBe(false);
    expect(genesis.taskforce.backends).toEqual([]);

    const rejected = await rawMutate(
      fixture,
      "/api/v1/plugins/terminal/carriers/genesis/taskforce/claude",
      "PUT",
      { model, ...(effort.supported ? { effort: effort.default } : {}) },
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "taskforce_not_capable" });
    const unchanged = await getJson<CarrierSettingsState>(`${fixture.endpoint}api/v1/plugins/terminal/carriers`);
    expect(unchanged.generation).toBe(initial.generation);

    const cleaned = await mutate<{ readonly state: CarrierSettingsState }>(
      fixture,
      "/api/v1/plugins/terminal/carriers/genesis/taskforce",
      "DELETE",
      {},
    );
    expect(cleaned.state.carriers.find((carrier) => carrier.carrierId === "genesis")?.taskforce.backends).toEqual([]);
    expect(cleaned.state.generation).toBe(unchanged.generation + 1);
    const persisted = JSON.parse(fs.readFileSync(path.join(fixture.carrierStoreDir, "carriers.json"), "utf8")) as {
      readonly _meta?: { readonly generation?: number };
      readonly carriers?: Record<string, { readonly taskforce?: unknown }>;
    };
    expect(persisted._meta?.generation).toBe(cleaned.state.generation);
    expect(persisted.carriers?.genesis?.taskforce).toBeUndefined();
  });

  it("does not return 500 for malformed percent-encoded carrier ids", async () => {
    const fixture = await startFixture();

    const response = await rawMutate(fixture, "/api/v1/plugins/terminal/carriers/%ZZ", "PATCH", { displayName: "X" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it("accepts every advertised model and effort selection in mutations", async () => {
    const fixture = await startFixture();
    const options = await getJson<CarrierSettingsOptions>(`${fixture.endpoint}api/v1/plugins/terminal/carriers/options`);
    const state = await getJson<CarrierSettingsState>(`${fixture.endpoint}api/v1/plugins/terminal/carriers`);
    const carrier = state.carriers[0]!;

    for (const cli of options.cliTypes) {
      await mutate<{ readonly state: CarrierSettingsState }>(
        fixture,
        `/api/v1/plugins/terminal/carriers/${carrier.carrierId}`,
        "PATCH",
        { cli: cli.id },
      );
      for (const model of cli.models) {
        const response = await rawMutate(
          fixture,
          `/api/v1/plugins/terminal/carriers/${carrier.carrierId}`,
          "PATCH",
          { model: selectionFor(model) },
        );
        expect(response.status, `${cli.id}/${model.modelId}`).toBe(200);
        await response.arrayBuffer();
      }
    }
  });

  it("relocates carrier persistence with FLEET_CONSOLE_DIR when dataDir is omitted", async () => {
    // dataDir 미지정 + FLEET_CONSOLE_DIR 격리 슬롯 — 플러그인 fleet 루트가 실사용자 store로 폴백하면 안 된다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-carrier-env-"));
    tempDirs.push(dir);
    const consoleDir = path.join(dir, "console-slot");
    fs.mkdirSync(consoleDir, { recursive: true });
    vi.stubEnv("FLEET_CONSOLE_DIR", consoleDir);
    try {
      const lockFile = path.join(dir, "console.lock");
      const server = createConsoleServer({
        port: 0,
        version: "test",
        agentRuntime: createFakeConsoleRuntime() as never,
      });
      servers.push(server);
      const endpoint = await server.start({ dir, lockFile });
      const lock = createConsoleLock().readLock(lockFile)!;
      const fixture = { endpoint, lock } as ServerFixture;

      const state = await getJson<CarrierSettingsState>(`${endpoint}api/v1/plugins/terminal/carriers`);
      const carrier = state.carriers[0]!;
      await mutate(fixture, `/api/v1/plugins/terminal/carriers/${carrier.carrierId}`, "PATCH", { displayName: "Env Isolated" });

      const persisted = JSON.parse(fs.readFileSync(path.join(consoleDir, "carriers.json"), "utf8")) as {
        readonly carriers?: Record<string, { readonly displayName?: string }>;
      };
      expect(persisted.carriers?.[carrier.carrierId]?.displayName).toBe("Env Isolated");
    } finally {
      vi.unstubAllEnvs();
    }
  });

});

async function startFixture(options: {
  readonly beforeCreateServer?: (paths: { readonly carrierStoreDir: string }) => void;
  readonly agentRuntime?: ConsoleServerDeps["agentRuntime"];
} = {}): Promise<ServerFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-carrier-settings-"));
  const carrierStoreDir = path.join(dir, "fleet-home");
  initStore(carrierStoreDir);
  options.beforeCreateServer?.({ carrierStoreDir });
  tempDirs.push(dir);
  const lockFile = path.join(dir, "console.lock");
  const server = createConsoleServer({
    port: 0,
    version: "test",
    agentRuntime: options.agentRuntime ?? createFakeConsoleRuntime() as never,
    dataDir: carrierStoreDir,
  });
  servers.push(server);
  const endpoint = await server.start({ dir, lockFile });
  const lock = createConsoleLock().readLock(lockFile)!;
  return { dir, carrierStoreDir, lockFile, server, endpoint, lock };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function mutate<T>(fixture: ServerFixture, pathname: string, method: string, body: unknown): Promise<T> {
  const response = await rawMutate(fixture, pathname, method, body);
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

async function rawMutate(fixture: ServerFixture, pathname: string, method: string, body: unknown): Promise<Response> {
  return fetch(`${fixture.endpoint}${pathname.replace(/^\//, "")}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: `http://127.0.0.1:${fixture.lock.port}`,
    },
    body: JSON.stringify(body),
  });
}

async function findClaudeCarrier(fixture: ServerFixture): Promise<CarrierSettingsCarrier> {
  const state = await getJson<CarrierSettingsState>(`${fixture.endpoint}api/v1/plugins/terminal/carriers`);
  return state.carriers.find((carrier) => carrier.cliType === "claude") ?? state.carriers[0]!;
}

function selectionFor(model: { readonly modelId: string; readonly effort?: { readonly default: string } }): { readonly model: string; readonly effort?: string } {
  return {
    model: model.modelId,
    ...(model.effort ? { effort: model.effort.default } : {}),
  };
}

function getCliTypes(): readonly CliType[] {
  return Object.keys(CLI_BACKENDS) as CliType[];
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
