import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProviderModels, type CliType } from "@dotobokuri/core-unified-agent";

import {
  getCarriersFilePath,
  initStore,
  readCarriersSnapshot,
  resetCarrierTaskForceConfig,
  resetStoreForTests,
  updateTaskForceModelSelection,
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
    updateTaskForceModelSelection("ohio", "claude", { model: firstModel("claude") });
    updateTaskForceModelSelection("ohio", "codex", { model: firstModel("codex") });
    updateTaskForceModelSelection("genesis", "codex", { model: firstModel("codex") });

    expect(resetCarrierTaskForceConfig("ohio")).toBe(true);

    const snapshot = readCarriersSnapshot();
    expect(snapshot.carriers.ohio?.taskforce).toBeUndefined();
    expect(snapshot.carriers.genesis?.taskforce?.codex?.model).toBe(firstModel("codex"));
  });

  it("returns false without writing when the carrier has no Task Force config", () => {
    expect(resetCarrierTaskForceConfig("ohio")).toBe(false);
    expect(fs.existsSync(getCarriersFilePath()!)).toBe(false);
  });
});

function firstModel(cliType: CliType): string {
  const model = getProviderModels(cliType).models[0]?.modelId;
  if (!model) throw new Error(`No test model for ${cliType}`);
  return model;
}
