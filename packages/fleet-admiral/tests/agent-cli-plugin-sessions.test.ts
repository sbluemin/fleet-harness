import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findGatewayModel, type GatewayModel } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

import { FLEET_HARNESS_VERSION } from "../src/agent-cli/assets.generated.js";
import { createAgentCliPlugin, fleetClaudePluginRoot } from "../src/agent-cli/plugin/index.js";
import { publishSharedPlugin } from "../src/agent-cli/plugin/shared-store.js";
import type { CreateAgentCliPluginOptions } from "../src/agent-cli/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent CLI shared plugin store", () => {
  it("publishes one shared tree under the Fleet data directory's harness/claude path", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-shared-root-");

    const plugin = await createAgentCliPlugin(options({ cwd, dataDir }));

    expect(plugin.pluginRoot).toBe(path.join(dataDir, "harness", "claude"));
    expect(plugin.pluginRoot).toBe(fleetClaudePluginRoot(dataDir));
    expect(plugin.pluginRoots).toEqual([plugin.pluginRoot]);
    expect(existsSync(path.join(plugin.pluginRoot, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "agents"))).toBe(true);
    expect(existsSync(path.join(dataDir, "workspaces"))).toBe(false);
  });

  it("leaves the previous tree intact when staging the next render fails", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-shared-stage-failure-");
    const plugin = await createAgentCliPlugin(options({ cwd, dataDir }));
    const guardPath = path.join(plugin.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs");
    const guardBefore = readFileSync(guardPath, "utf8");

    expect(() => publishSharedPlugin(dataDir, plugin.pluginRoot, [{
      relativePath: "hooks/blocked/file.txt",
      content: "unreachable\n",
    }, {
      relativePath: "hooks/blocked",
      content: "not a directory\n",
    }])).toThrow();

    expect(readFileSync(guardPath, "utf8")).toBe(guardBefore);
    expect(existsSync(path.join(plugin.pluginRoot, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("replaces a tree whose agents directory was swapped for a symlink", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-shared-agents-link-");

    const first = await createAgentCliPlugin(options({ cwd, dataDir }));
    const agentsPath = path.join(first.pluginRoot, "agents");
    const outside = path.join(dataDir, "outside-agents");
    mkdirSync(outside, { recursive: true });
    rmSync(agentsPath, { recursive: true, force: true });
    symlinkSync(outside, agentsPath, "junction");

    const second = await createAgentCliPlugin(options({ cwd, dataDir }));

    const restored = readdirSync(second.pluginRoot, { withFileTypes: true }).find((entry) => entry.name === "agents");
    expect(restored?.isDirectory()).toBe(true);
    expect(restored?.isSymbolicLink()).toBe(false);
  });

});

function options(input: {
  readonly cwd: string;
  readonly dataDir: string;
}): CreateAgentCliPluginOptions {
  return { cliId: "claude", cwd: input.cwd, dataDir: input.dataDir };
}

function createRoots(prefix: string): { readonly dataDir: string; readonly cwd: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const cwd = path.join(root, "project");
  mkdirSync(cwd, { recursive: true });
  return { dataDir: path.join(root, "data"), cwd };
}

function requireGatewayModel(modelId: string): GatewayModel {
  const model = findGatewayModel(modelId);
  if (!model) throw new Error(`Catalog model missing for test: ${modelId}`);
  return model;
}

function seedLegacyMarketplace(dataDir: string): string {
  const legacyRoot = path.join(dataDir, "marketplace", "plugins", "fleet-gateway");
  mkdirSync(path.join(legacyRoot, "hooks"), { recursive: true });
  mkdirSync(path.join(dataDir, "marketplace", ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(legacyRoot, "hooks", "hooks.json"), "{\"hooks\":{}}\n");
  writeFileSync(path.join(dataDir, "marketplace", "user-note.txt"), "legacy user file\n");
  return legacyRoot;
}
