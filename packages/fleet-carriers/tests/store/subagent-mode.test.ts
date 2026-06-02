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
  setCarrierAgentModeWithCodexRole,
  type CarrierConfig,
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

  it("writes and removes derived Codex role files inside the store domain", () => {
    setCarrierAgentModeWithCodexRole(createCarrierConfig("ohio"), true, { model: "gpt-5.4", effort: "high" });
    const roleFile = path.join(tempDir!, "codex-agents/ohio.toml");

    expect(fs.existsSync(roleFile)).toBe(true);
    expect(fs.readFileSync(roleFile, "utf8")).toContain('model_reasoning_effort = "high"');

    setCarrierAgentModeWithCodexRole(createCarrierConfig("ohio"), false);

    expect(fs.existsSync(roleFile)).toBe(false);
    expect(readCarrierAgentModeSnapshot().agentModes).toEqual({});
  });

  it("does not enable state when Codex role file write fails", () => {
    expect(tempDir).toBeTruthy();
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-role-target-"));
    fs.symlinkSync(targetDir, path.join(tempDir!, "codex-agents"), "dir");

    expect(() => setCarrierAgentModeWithCodexRole(createCarrierConfig("ohio"), true)).toThrow(/symlink/);
    expect(readCarrierAgentModeSnapshot().agentModes).toEqual({});

    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  it("keeps state enabled when Codex role file removal fails", () => {
    setCarrierAgentModeWithCodexRole(createCarrierConfig("ohio"), true);
    const roleFile = path.join(tempDir!, "codex-agents/ohio.toml");
    fs.rmSync(roleFile, { force: true });
    fs.mkdirSync(roleFile);

    expect(() => setCarrierAgentModeWithCodexRole(createCarrierConfig("ohio"), false)).toThrow();
    expect(readCarrierAgentModeSnapshot().agentModes).toEqual({ ohio: "subagent" });
  });

  it("rejects enabling when the candidate collides with an existing enabled Codex role key", () => {
    setCarrierAgentModeWithCodexRole(createCarrierConfig("fleet_vanguard"), true);
    const roleFile = path.join(tempDir!, "codex-agents/vanguard.toml");
    const before = fs.readFileSync(roleFile, "utf8");

    expect(() => setCarrierAgentModeWithCodexRole(createCarrierConfig("vanguard"), true)).toThrow(/role key collision/);
    expect(readCarrierAgentModeSnapshot().agentModes).toEqual({ fleet_vanguard: "subagent" });
    expect(fs.readFileSync(roleFile, "utf8")).toBe(before);
  });

  it("ignores unregistered stale carrier modes during role collision checks", () => {
    setCarrierAgentModeWithCodexRole(createCarrierConfig("fleet_vanguard"), true);
    setCarrierAgentModeWithCodexRole(createCarrierConfig("vanguard"), true, undefined, {
      registeredCarrierIds: ["vanguard"],
    });

    expect(readCarrierAgentModeSnapshot().agentModes).toEqual({
      fleet_vanguard: "subagent",
      vanguard: "subagent",
    });
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

function createCarrierConfig(id: string): CarrierConfig {
  return {
    carrierMetadata: {
      category: "operations",
      outputFormat: "Report completion.",
      permissions: ["Execute only the assigned wave."],
      principles: ["Follow the plan."],
      requestBlocks: [],
      summary: "Multi-wave execution",
      title: "Captain",
      whenNotToUse: [],
      whenToUse: ["plan-file execution"],
    },
    defaultCliType: "claude",
    displayName: id[0]!.toUpperCase() + id.slice(1),
    id,
    slot: 1,
    subagent: {
      byHost: {
        codex: { defaultModel: "gpt-5.5", defaultEffort: "low" },
      },
    },
  };
}
