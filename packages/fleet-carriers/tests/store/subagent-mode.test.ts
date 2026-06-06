import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getEnabledCarrierSubagentIds,
  getCarriersFilePath,
  initStore,
  readCarrierAgentModeSnapshot,
  resetStoreForTests,
  setCarrierAgentMode,
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
    setCarrierAgentMode("ohio", true);

    const filePath = getCarriersFilePath();
    expect(filePath).toBeTruthy();
    const raw = JSON.parse(fs.readFileSync(filePath!, "utf-8")) as Record<string, unknown>;

    expect(raw.carriers).toEqual({ ohio: { agentMode: "subagent" } });
    expect((raw._meta as { generation?: number }).generation).toBe(1);
    expect(raw.generation).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain("prompt");
    expect(JSON.stringify(raw)).not.toContain("description");
    expect(JSON.stringify(raw)).not.toContain("tools");
  });

  it("ignores corrupt and unknown persisted values safely", () => {
    const filePath = getCarriersFilePath();
    fs.writeFileSync(filePath!, JSON.stringify({
      _meta: { generation: 3 },
      carriers: {
        bad: { agentMode: "native" },
        ohio: { agentMode: "subagent" },
      },
    }), "utf-8");

    expect(readCarrierAgentModeSnapshot().agentModes).toEqual({ ohio: "subagent" });
    expect(getEnabledCarrierSubagentIds(readCarrierAgentModeSnapshot(), ["sentinel"])).toEqual([]);
  });

  it("routes disabling through carriers.json CAS generation", () => {
    setCarrierAgentMode("ohio", true);
    setCarrierAgentMode("ohio", false);

    const filePath = getCarriersFilePath();
    const raw = JSON.parse(fs.readFileSync(filePath!, "utf-8")) as Record<string, unknown>;

    expect(raw.carriers).toBeUndefined();
    expect((raw._meta as { generation?: number }).generation).toBe(2);
  });

  it("persists agentMode only when it differs from the persona default", () => {
    setCarrierAgentMode("ohio", true, "subagent");

    const filePath = getCarriersFilePath();
    const rawAfterDefault = JSON.parse(fs.readFileSync(filePath!, "utf-8")) as Record<string, unknown>;
    expect(rawAfterDefault.carriers).toBeUndefined();
    expect(readCarrierAgentModeSnapshot({
      ohio: { cliType: "claude", defaultAgentMode: "subagent" },
    }).agentModes).toEqual({ ohio: "subagent" });

    setCarrierAgentMode("ohio", false, "subagent");

    const rawAfterOverride = JSON.parse(fs.readFileSync(filePath!, "utf-8")) as Record<string, unknown>;
    expect(rawAfterOverride.carriers).toEqual({ ohio: { agentMode: "cli" } });
    expect(readCarrierAgentModeSnapshot({
      ohio: { cliType: "claude", defaultAgentMode: "subagent" },
    }).agentModes).toEqual({});
  });

  it("removes stale carrier-subagent.json on init without migration", () => {
    resetStoreForTests();
    expect(tempDir).toBeTruthy();
    const stalePath = path.join(tempDir!, "carrier-subagent.json");
    fs.writeFileSync(stalePath, JSON.stringify({
      agentModes: {
        ohio: "subagent",
      },
    }), "utf-8");

    initStore(tempDir!);

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(readCarrierAgentModeSnapshot().agentModes).toEqual({});
  });
});
