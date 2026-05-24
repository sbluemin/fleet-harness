import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CarrierConfig,
  createCarrierRegistry,
  getCarrierSourceDisplayName,
  initStore,
  registerCarrier,
  resetStoreForTests,
  resolveCarrierDisplayName,
  updateCarrierDisplayName,
} from "../../src/index.js";

const C1_CSI = "\u009b2J";

let tempDir: string | null = null;

describe("carrier displayName resolution", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-framework-display-names-"));
    initStore(tempDir);
  });

  afterEach(() => {
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("applies persisted displayName sanitizer policy to source display names", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("custom_alpha", "  Alpha\u200B\u202E Prime  "));

    expect(getCarrierSourceDisplayName(registry, "custom_alpha")).toBe("Alpha Prime");
    expect(resolveCarrierDisplayName(registry, "custom_alpha")).toBe("Alpha Prime");
  });

  it("blocks source display names containing C0, DEL, or C1 controls", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("custom_alpha", `Alpha${C1_CSI}Prime`));

    expect(getCarrierSourceDisplayName(registry, "custom_alpha")).toBe("custom_alpha");
    expect(resolveCarrierDisplayName(registry, "custom_alpha")).toBe("custom_alpha");
  });

  it("preserves persisted override and delete semantics over sanitized source defaults", () => {
    const registry = createCarrierRegistry();
    registerCarrier(registry, createConfig("custom_alpha", "Alpha\u200B Prime"));

    updateCarrierDisplayName("custom_alpha", "Alpha Override", getCarrierSourceDisplayName(registry, "custom_alpha"));
    expect(resolveCarrierDisplayName(registry, "custom_alpha")).toBe("Alpha Override");

    updateCarrierDisplayName("custom_alpha", "Alpha Prime", getCarrierSourceDisplayName(registry, "custom_alpha"));
    expect(resolveCarrierDisplayName(registry, "custom_alpha")).toBe("Alpha Prime");
  });
});

function createConfig(id: string, displayName: string): CarrierConfig {
  return {
    id,
    cliType: "claude",
    defaultCliType: "claude",
    slot: 1,
    displayName,
    color: "",
  };
}
