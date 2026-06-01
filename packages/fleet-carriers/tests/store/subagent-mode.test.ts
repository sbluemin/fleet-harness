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
  setCarrierSubagentModeWithCodexRole,
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

  it("writes and removes derived Codex role files inside the store domain", () => {
    setCarrierSubagentModeWithCodexRole(createCarrierConfig("ohio"), true, { model: "gpt-5.4", effort: "high" });
    const roleFile = path.join(tempDir!, "codex-agents/ohio.toml");

    expect(fs.existsSync(roleFile)).toBe(true);
    expect(fs.readFileSync(roleFile, "utf8")).toContain('model_reasoning_effort = "high"');

    setCarrierSubagentModeWithCodexRole(createCarrierConfig("ohio"), false);

    expect(fs.existsSync(roleFile)).toBe(false);
    expect(readCarrierSubagentModeSnapshot().carrierModes).toEqual({});
  });

  it("does not enable state when Codex role file write fails", () => {
    expect(tempDir).toBeTruthy();
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-role-target-"));
    fs.symlinkSync(targetDir, path.join(tempDir!, "codex-agents"), "dir");

    expect(() => setCarrierSubagentModeWithCodexRole(createCarrierConfig("ohio"), true)).toThrow(/symlink/);
    expect(readCarrierSubagentModeSnapshot().carrierModes).toEqual({});

    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  it("keeps state enabled when Codex role file removal fails", () => {
    setCarrierSubagentModeWithCodexRole(createCarrierConfig("ohio"), true);
    const roleFile = path.join(tempDir!, "codex-agents/ohio.toml");
    fs.rmSync(roleFile, { force: true });
    fs.mkdirSync(roleFile);

    expect(() => setCarrierSubagentModeWithCodexRole(createCarrierConfig("ohio"), false)).toThrow();
    expect(readCarrierSubagentModeSnapshot().carrierModes).toEqual({ ohio: "subagent" });
  });

  it("rejects enabling when the candidate collides with an existing enabled Codex role key", () => {
    setCarrierSubagentModeWithCodexRole(createCarrierConfig("fleet_vanguard"), true);
    const roleFile = path.join(tempDir!, "codex-agents/vanguard.toml");
    const before = fs.readFileSync(roleFile, "utf8");

    expect(() => setCarrierSubagentModeWithCodexRole(createCarrierConfig("vanguard"), true)).toThrow(/role key collision/);
    expect(readCarrierSubagentModeSnapshot().carrierModes).toEqual({ fleet_vanguard: "subagent" });
    expect(fs.readFileSync(roleFile, "utf8")).toBe(before);
  });

  it("ignores unregistered stale carrier modes during role collision checks", () => {
    setCarrierSubagentModeWithCodexRole(createCarrierConfig("fleet_vanguard"), true);
    setCarrierSubagentModeWithCodexRole(createCarrierConfig("vanguard"), true, undefined, {
      registeredCarrierIds: ["vanguard"],
    });

    expect(readCarrierSubagentModeSnapshot().carrierModes).toEqual({
      fleet_vanguard: "subagent",
      vanguard: "subagent",
    });
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
    color: "",
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
