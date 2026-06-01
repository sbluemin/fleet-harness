import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCodexSubagentDefinition,
  ensureCodexSubagentRoleFile,
  getCodexSubagentRoleFilePath,
  initStore,
  resetStoreForTests,
  serializeCodexSubagentRoleToml,
  setCarrierSubagentModeWithCodexRole,
  type CarrierConfig,
} from "../../src/index.js";
import { getCodexSubagentInstructionsFilePath } from "../../src/store/codex-subagent-files.js";

let tempDir: string | null = null;

const require = createRequire(import.meta.url);
const mutableFs = require("node:fs") as typeof fs;

describe("Codex subagent role file store", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-role-store-"));
    initStore(tempDir);
  });

  afterEach(() => {
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("serializes model_reasoning_effort and never effort", () => {
    const toml = serializeCodexSubagentRoleToml(buildCodexSubagentDefinition(createCarrierConfig("tempest")).toml);

    expect(toml).toContain('model = "gpt-5.4-mini"');
    expect(toml).toContain('model_reasoning_effort = "xhigh"');
    expect(toml).not.toMatch(/^effort =/m);
  });

  it("serializes model_instructions_file as a TOML basic string", () => {
    const toml = serializeCodexSubagentRoleToml({
      ...buildCodexSubagentDefinition(createCarrierConfig("tempest")).toml,
      model_instructions_file: "/tmp/codex-agents/tempest.md",
    });

    expect(toml).toContain('model_instructions_file = "/tmp/codex-agents/tempest.md"');
    expect(toml).not.toContain("developer_instructions");
  });

  it("writes shared role and raw instructions files under the Fleet data dir", () => {
    const definition = buildCodexSubagentDefinition(createCarrierConfig("ohio"));
    const prepared = ensureCodexSubagentRoleFile(definition);

    expect(prepared?.configFile).toBe(path.join(tempDir!, "codex-agents/ohio.toml"));
    expect(prepared?.instructionsFile).toBe(path.join(tempDir!, "codex-agents/ohio.md"));
    expect(getCodexSubagentRoleFilePath("ohio")).toBe(prepared?.configFile);
    expect(getCodexSubagentInstructionsFilePath("ohio")).toBe(prepared?.instructionsFile);
    expect(fs.statSync(path.join(tempDir!, "codex-agents")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(prepared!.configFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(prepared!.instructionsFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(prepared!.configFile, "utf8")).toContain('name = "ohio"');
    expect(fs.readFileSync(prepared!.configFile, "utf8")).toContain(`model_instructions_file = "${prepared!.instructionsFile}"`);
    expect(fs.readFileSync(prepared!.configFile, "utf8")).not.toContain("developer_instructions");
    expect(fs.readFileSync(prepared!.instructionsFile, "utf8")).toBe(definition.instructions);
    expect(path.resolve(prepared!.configFile).startsWith(`${path.resolve(tempDir!)}${path.sep}`)).toBe(true);
    expect(path.resolve(prepared!.instructionsFile).startsWith(`${path.resolve(tempDir!)}${path.sep}`)).toBe(true);
  });

  it("rejects role file paths outside the Codex agents root", () => {
    const definition = {
      ...buildCodexSubagentDefinition(createCarrierConfig("ohio")),
      roleKey: "../escape",
    };

    expect(() => getCodexSubagentRoleFilePath("../escape")).toThrow(/escapes root/);
    expect(() => getCodexSubagentInstructionsFilePath("../escape")).toThrow(/escapes root/);
    expect(() => ensureCodexSubagentRoleFile(definition)).toThrow(/escapes root/);
    expect(fs.existsSync(path.join(tempDir!, "escape.toml"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir!, "escape.md"))).toBe(false);
  });

  it("rejects Codex agents root symlinks before writing role files", () => {
    expect(tempDir).toBeTruthy();
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-role-target-"));
    fs.symlinkSync(targetDir, path.join(tempDir!, "codex-agents"), "dir");

    expect(() => ensureCodexSubagentRoleFile(buildCodexSubagentDefinition(createCarrierConfig("ohio")))).toThrow(/symlink/);
    expect(fs.existsSync(path.join(targetDir, "ohio.toml"))).toBe(false);

    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  it("rejects role writes when the Codex agents root identity changes before rename", () => {
    expect(tempDir).toBeTruthy();
    const rootDir = path.join(tempDir!, "codex-agents");
    const originalWriteFileSync = mutableFs.writeFileSync as unknown as (...args: unknown[]) => unknown;
    const replacement = ((...args: unknown[]) => {
      const filePath = String(args[0]);
      if (filePath.includes(`${path.sep}codex-agents${path.sep}ohio.md.`) && filePath.endsWith(".tmp")) {
        fs.rmSync(rootDir, { recursive: true, force: true });
        fs.mkdirSync(rootDir);
      }
      return originalWriteFileSync(...args);
    }) as typeof fs.writeFileSync;

    mutableFs.writeFileSync = replacement;
    syncBuiltinESMExports();
    try {
      expect(() => ensureCodexSubagentRoleFile(buildCodexSubagentDefinition(createCarrierConfig("ohio")))).toThrow(/changed/);
      expect(fs.existsSync(path.join(rootDir, "ohio.toml"))).toBe(false);
    } finally {
      mutableFs.writeFileSync = originalWriteFileSync as typeof fs.writeFileSync;
      syncBuiltinESMExports();
    }
  });

  it("rejects role removals when the Codex agents root identity changes during unlink", () => {
    expect(tempDir).toBeTruthy();
    const rootDir = path.join(tempDir!, "codex-agents");
    const prepared = ensureCodexSubagentRoleFile(buildCodexSubagentDefinition(createCarrierConfig("ohio")))!;
    const originalUnlinkSync = mutableFs.unlinkSync as unknown as (...args: unknown[]) => unknown;
    const replacement = ((...args: unknown[]) => {
      if (String(args[0]) === prepared.configFile) {
        fs.rmSync(rootDir, { recursive: true, force: true });
        fs.mkdirSync(rootDir);
      }
      return originalUnlinkSync(...args);
    }) as typeof fs.unlinkSync;

    mutableFs.unlinkSync = replacement;
    syncBuiltinESMExports();
    try {
      expect(() => setCarrierSubagentModeWithCodexRole(createCarrierConfig("ohio"), false)).toThrow(/changed/);
    } finally {
      mutableFs.unlinkSync = originalUnlinkSync as typeof fs.unlinkSync;
      syncBuiltinESMExports();
    }
  });

  it("repeated enable overwrites the same files and disable removes exactly those files", () => {
    const first = buildCodexSubagentDefinition(createCarrierConfig("ohio"));
    const secondConfig = {
      ...createCarrierConfig("ohio"),
      subagent: { byHost: { codex: { defaultModel: "gpt-5.4", defaultEffort: "high" } } },
    };
    const second = buildCodexSubagentDefinition(secondConfig);

    const firstPrepared = ensureCodexSubagentRoleFile(first)!;
    const secondPrepared = ensureCodexSubagentRoleFile(second)!;

    expect(secondPrepared.configFile).toBe(firstPrepared.configFile);
    expect(secondPrepared.instructionsFile).toBe(firstPrepared.instructionsFile);
    expect(fs.readFileSync(secondPrepared.configFile, "utf8")).toContain('model = "gpt-5.4"');

    setCarrierSubagentModeWithCodexRole(secondConfig, false);
    expect(fs.existsSync(secondPrepared.configFile)).toBe(false);
    expect(fs.existsSync(secondPrepared.instructionsFile)).toBe(false);
    expect(fs.existsSync(path.join(tempDir!, "codex-agents"))).toBe(true);
    expect(() => setCarrierSubagentModeWithCodexRole(secondConfig, false)).not.toThrow();
  });
});

function createCarrierConfig(id: string): CarrierConfig {
  const codexDefaults = id === "tempest"
    ? { defaultModel: "gpt-5.4-mini", defaultEffort: "xhigh" }
    : { defaultModel: "gpt-5.5", defaultEffort: "low" };

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
        codex: codexDefaults,
      },
    },
  };
}
