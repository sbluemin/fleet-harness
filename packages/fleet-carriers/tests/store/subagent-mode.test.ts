import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getEnabledCarrierSubagentIds,
  getSubagentModeFilePath,
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

    const filePath = getSubagentModeFilePath();
    expect(filePath).toBeTruthy();
    const raw = JSON.parse(fs.readFileSync(filePath!, "utf-8")) as Record<string, unknown>;

    expect(raw.carrierModes).toEqual({ ohio: "subagent" });
    expect(JSON.stringify(raw)).not.toContain("prompt");
    expect(JSON.stringify(raw)).not.toContain("description");
    expect(JSON.stringify(raw)).not.toContain("tools");
  });

  it("ignores corrupt and unknown persisted values safely", () => {
    const filePath = getSubagentModeFilePath();
    fs.writeFileSync(filePath!, JSON.stringify({
      carrierModes: {
        bad: "native",
        ohio: "subagent",
      },
    }), "utf-8");

    expect(readCarrierSubagentModeSnapshot().carrierModes).toEqual({ ohio: "subagent" });
    expect(getEnabledCarrierSubagentIds(readCarrierSubagentModeSnapshot(), ["sentinel"])).toEqual([]);
  });
});
