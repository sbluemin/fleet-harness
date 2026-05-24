import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  initStore,
  loadCarrierDisplayNames,
  normalizeCarrierDisplayNameInput,
  resetStoreForTests,
  sanitizeCarrierDisplayName,
  updateCarrierDisplayName,
} from "../../src/index.js";

const C1_CSI = "\u009b2J";
const C1_OSC = "\u009d52;c;AAAA\u009c";

let tempDir: string | null = null;

describe("carrier displayName sanitization", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-display-names-"));
    initStore(tempDir);
  });

  afterEach(() => {
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("preserves printable names and existing blank semantics", () => {
    expect(normalizeCarrierDisplayNameInput("  Genesis Prime  ")).toBe("  Genesis Prime  ");
    expect(sanitizeCarrierDisplayName("  Genesis Prime  ")).toBe("Genesis Prime");
    expect(sanitizeCarrierDisplayName(" \t ")).toBeNull();
  });

  it("rejects C0, DEL, and C1 controls", () => {
    expect(normalizeCarrierDisplayNameInput("Genesis\u0007Prime")).toBeNull();
    expect(normalizeCarrierDisplayNameInput("Genesis\u007fPrime")).toBeNull();
    expect(normalizeCarrierDisplayNameInput(`Genesis${C1_CSI}Prime`)).toBeNull();
    expect(normalizeCarrierDisplayNameInput(`Genesis${C1_OSC}Prime`)).toBeNull();
  });

  it("drops persisted displayName overrides containing C1 controls", () => {
    writeStates({
      carrierDisplayNames: {
        genesis: `Genesis${C1_CSI}Prime`,
        sentinel: "Sentinel Prime",
      },
    });

    expect(loadCarrierDisplayNames()).toEqual({ sentinel: "Sentinel Prime" });
  });

  it("keeps delete semantics when a C1-tainted displayName is written", () => {
    updateCarrierDisplayName("genesis", "Genesis Prime", "Genesis");
    expect(loadCarrierDisplayNames()).toEqual({ genesis: "Genesis Prime" });

    updateCarrierDisplayName("genesis", `Genesis${C1_CSI}Prime`, "Genesis");
    expect(loadCarrierDisplayNames()).toEqual({});
  });
});

function writeStates(value: unknown): void {
  if (!tempDir) throw new Error("테스트 store가 초기화되지 않았습니다.");
  fs.writeFileSync(path.join(tempDir, "states.json"), JSON.stringify(value), "utf-8");
}
