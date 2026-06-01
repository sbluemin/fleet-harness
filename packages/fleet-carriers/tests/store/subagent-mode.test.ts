import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getEnabledCarrierSubagentIds,
  getStatesFilePath,
  initStore,
  readCarrierSubagentModeSnapshot,
  resetStoreForTests,
  setCarrierSubagentMode,
} from "../../src/index.js";

let tempDir: string | null = null;

describe("carrier subagent mode store", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-subagent-mode-"));
    initStore(tempDir);
  });

  afterEach(() => {
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("persists only mode state", () => {
    setCarrierSubagentMode("ohio", true);

    const filePath = getStatesFilePath();
    expect(filePath).toBeTruthy();
    const raw = JSON.parse(fs.readFileSync(filePath!, "utf-8")) as Record<string, unknown>;

    expect(raw.carrierModes).toEqual({ ohio: "subagent" });
    expect(raw._generation).toBe(1);
    expect(raw.generation).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain("prompt");
    expect(JSON.stringify(raw)).not.toContain("description");
    expect(JSON.stringify(raw)).not.toContain("tools");
  });

  it("ignores corrupt and unknown persisted values safely", () => {
    const filePath = getStatesFilePath();
    fs.writeFileSync(filePath!, JSON.stringify({
      _generation: 3,
      carrierModes: {
        bad: "native",
        ohio: "subagent",
      },
    }), "utf-8");

    expect(readCarrierSubagentModeSnapshot().carrierModes).toEqual({ ohio: "subagent" });
    expect(getEnabledCarrierSubagentIds(readCarrierSubagentModeSnapshot(), ["sentinel"])).toEqual([]);
  });

  it("routes disabling through states.json CAS generation", () => {
    setCarrierSubagentMode("ohio", true);
    setCarrierSubagentMode("ohio", false);

    const filePath = getStatesFilePath();
    const raw = JSON.parse(fs.readFileSync(filePath!, "utf-8")) as Record<string, unknown>;

    expect(raw.carrierModes).toBeUndefined();
    expect(raw._generation).toBe(2);
  });

  it("removes stale carrier-subagent.json on init without migration", () => {
    resetStoreForTests();
    expect(tempDir).toBeTruthy();
    const stalePath = path.join(tempDir!, "carrier-subagent.json");
    fs.writeFileSync(stalePath, JSON.stringify({
      carrierModes: {
        ohio: "subagent",
      },
    }), "utf-8");

    initStore(tempDir!);

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(readCarrierSubagentModeSnapshot().carrierModes).toEqual({});
  });
});
