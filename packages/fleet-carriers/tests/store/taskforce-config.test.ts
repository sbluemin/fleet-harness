import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProviderModels, type CliType } from "@dotobokuri/core-unified-agent";

import {
  getCarriersFilePath,
  initStore,
  readCarriersSnapshot,
  clearTaskForceConfig,
  resetStoreForTests,
  type CarrierRegistry,
  createCarrierRegistry,
  registerCarrier,
  setTaskForceBackend,
} from "../../src/index.js";

let tempDir: string | null = null;

describe("carrier taskforce config store", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-taskforce-config-"));
    initStore(tempDir);
  });

  afterEach(() => {
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("removes all Task Force backend selections for one carrier", () => {
    const registry = registerCapableCarriers();
    setTaskForceBackend(registry, "vanguard", "claude", { model: firstModel("claude") });
    setTaskForceBackend(registry, "vanguard", "codex", { model: firstModel("codex") });
    setTaskForceBackend(registry, "genesis", "codex", { model: firstModel("codex") });

    expect(clearTaskForceConfig("vanguard")).toBe(true);

    const snapshot = readCarriersSnapshot();
    expect(snapshot.carriers.vanguard?.taskforce).toBeUndefined();
    expect(snapshot.carriers.genesis?.taskforce?.codex?.model).toBe(firstModel("codex"));
  });

  it("returns false without writing when the carrier has no Task Force config", () => {
    expect(clearTaskForceConfig("vanguard")).toBe(false);
    expect(fs.existsSync(getCarriersFilePath()!)).toBe(false);
  });
});

function registerCapableCarriers(): CarrierRegistry {
  const registry = createCarrierRegistry();
  for (const id of ["vanguard", "genesis"]) {
    registerCarrier(registry, { id, displayName: id, slot: 1, defaultCliType: "claude", taskForceCapable: true });
  }
  return registry;
}

function firstModel(cliType: CliType): string {
  const model = getProviderModels(cliType).models[0]?.modelId;
  if (!model) throw new Error(`No test model for ${cliType}`);
  return model;
}
