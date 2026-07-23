import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProviderModels, type CliType } from "@dotobokuri/core-unified-agent";

import {
  clearTaskForceConfig,
  createCarrierRegistry,
  getCarriersFilePath,
  getEffectiveTaskForceBackends,
  isTaskForceCapable,
  isTaskForceFormable,
  launchTaskForceJob,
  registerCarrier,
  registerDefaultCarriers,
  removeTaskForceBackend,
  resetStoreForTests,
  setTaskForceBackend,
  initStore,
} from "../../src/index.js";

let tempDir: string | null = null;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-taskforce-policy-"));
  initStore(tempDir);
});

afterEach(() => {
  resetStoreForTests();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("Task Force capability policy", () => {
  it("source-enables exactly the three capable default personas while custom carriers stay closed", () => {
    const registry = createCarrierRegistry();
    registerDefaultCarriers(registry);
    registerCarrier(registry, config("custom", false));

    const capable = ["nimitz", "vanguard", "tempest", "kirov", "genesis", "ohio", "sentinel", "custom"]
      .filter((id) => isTaskForceCapable(registry, id));

    expect(capable).toEqual(["nimitz", "vanguard", "tempest"]);
  });

  it("makes stale settings ineffective when capability is removed and reactivates them when it returns", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, config("custom", true));
    setTaskForceBackend(registry, "custom", "claude", { model: firstModel("claude") });
    setTaskForceBackend(registry, "custom", "codex", { model: firstModel("codex") });
    expect(isTaskForceFormable(registry, "custom")).toBe(true);

    registerCarrier(registry, config("custom", false));
    expect(getEffectiveTaskForceBackends(registry, "custom")).toEqual([]);

    registerCarrier(registry, config("custom", true));
    expect(getEffectiveTaskForceBackends(registry, "custom")).toEqual(["claude", "codex"]);
  });

  it("rejects incapable writes without creating a store file while retaining registry-free cleanup", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, config("custom", false));

    expect(() => setTaskForceBackend(registry, "custom", "claude", { model: firstModel("claude") })).toThrow("taskforce_not_capable");
    expect(() => setTaskForceBackend(registry, "missing", "claude", { model: firstModel("claude") })).toThrow("carrier_not_found");
    expect(fs.existsSync(getCarriersFilePath()!)).toBe(false);
    expect(removeTaskForceBackend("custom", "claude")).toBeUndefined();
    expect(clearTaskForceConfig("custom")).toBe(false);
  });

  it("rejects direct Task Force launch for incapable carriers before backend validation", async () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, config("custom", false));

    await expect(launchTaskForceJob({
      registry,
      carrierId: "custom",
      request: "test",
      parsedRequest: { blocks: [], additional: "test" },
      label: "guard",
      startedAt: Date.now(),
      toolName: "carrier_dispatch",
      ctx: { toolCallId: "guard" } as never,
      cwd: "/tmp",
      deps: { authEnvResolver: () => Promise.resolve({}) } as never,
    })).rejects.toThrow("taskforce_not_capable");
  });
});

function config(id: string, taskForceCapable: boolean) {
  return {
    id,
    displayName: id,
    slot: 1,
    defaultCliType: "claude" as const,
    ...(taskForceCapable ? { taskForceCapable: true as const } : {}),
  };
}

function firstModel(cliType: CliType): string {
  const model = getProviderModels(cliType).models[0]?.modelId;
  if (!model) throw new Error(`No model for ${cliType}`);
  return model;
}
