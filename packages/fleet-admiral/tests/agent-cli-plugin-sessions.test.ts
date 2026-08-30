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

  it("renders the fleet-harness version into the manifest and SessionStart additionalContext hook", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-shared-version-");

    const plugin = await createAgentCliPlugin(options({ cwd, dataDir }));
    const manifest = JSON.parse(readFileSync(path.join(plugin.pluginRoot, ".claude-plugin", "plugin.json"), "utf8")) as {
      readonly version: string;
    };
    const hooksJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: Record<string, ReadonlyArray<{ readonly hooks: ReadonlyArray<{ readonly args: readonly string[] }> }>>;
    };

    expect(manifest.version).toBe(FLEET_HARNESS_VERSION);
    expect(manifest.version).not.toBe("0.0.0");
    expect(hooksJson.hooks.SessionStart).toEqual([{
      hooks: [{
        type: "command",
        command: process.execPath,
        args: [
          "${CLAUDE_PLUGIN_ROOT}/hooks/fleet-gateway-model-guard.mjs",
          "plugin-version",
          FLEET_HARNESS_VERSION,
        ],
      }],
    }]);
  });

  it("uses the same tree for every workspace and session", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-shared-sessions-");
    const otherCwd = path.join(path.dirname(cwd), "other-project");
    mkdirSync(otherCwd, { recursive: true });

    const first = await createAgentCliPlugin(options({ cwd, dataDir }));
    const second = await createAgentCliPlugin(options({ cwd: otherCwd, dataDir }));

    expect(second.pluginRoot).toBe(first.pluginRoot);
    expect(second.pluginRoot).toBe(path.join(dataDir, "harness", "claude"));
  });

  it("replaces the shared tree with the latest render", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-shared-replace-");

    const first = await createAgentCliPlugin(options({ cwd, dataDir }));
    const guardPath = path.join(first.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs");
    const original = readFileSync(guardPath, "utf8");
    writeFileSync(guardPath, "// tampered\n");
    rmSync(path.join(first.pluginRoot, "agents"), { recursive: true, force: true });
    writeFileSync(path.join(first.pluginRoot, "stray.txt"), "left over\n");

    const second = await createAgentCliPlugin(options({ cwd, dataDir }));

    expect(second.pluginRoot).toBe(first.pluginRoot);
    expect(readFileSync(guardPath, "utf8")).toBe(original);
    expect(existsSync(path.join(second.pluginRoot, "agents"))).toBe(true);
    expect(existsSync(path.join(second.pluginRoot, "stray.txt"))).toBe(false);
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

  describe("legacy marketplace tree", () => {
    it("never writes into it, and leaves a recently rendered one alone", async () => {
      const { dataDir, cwd } = createRoots("fleet-admiral-shared-legacy-recent-");
      const legacyRoot = seedLegacyMarketplace(dataDir);

      const plugin = await createAgentCliPlugin(options({ cwd, dataDir }));

      expect(plugin.pluginRoot).toBe(path.join(dataDir, "harness", "claude"));
      expect(readFileSync(path.join(legacyRoot, "hooks", "hooks.json"), "utf8")).toBe("{\"hooks\":{}}\n");
    });

    it("reclaims only what Fleet rendered once the tree has gone stale", async () => {
      const { dataDir, cwd } = createRoots("fleet-admiral-shared-legacy-stale-");
      const legacyRoot = seedLegacyMarketplace(dataDir);
      const marketplaceRoot = path.join(dataDir, "marketplace");

      await createAgentCliPlugin({
        ...options({ cwd, dataDir }),
        legacyReclaimDeps: { staleAfterMs: 0 },
      });

      expect(existsSync(legacyRoot)).toBe(false);
      expect(existsSync(path.join(marketplaceRoot, ".claude-plugin"))).toBe(false);
      expect(readFileSync(path.join(marketplaceRoot, "user-note.txt"), "utf8")).toBe("legacy user file\n");
    });
  });

  it("wires AskUserQuestion PreToolUse and input-waiting Notification hooks for a gateway session", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-shared-hooks-");

    const plugin = await createAgentCliPlugin({
      ...options({ cwd, dataDir }),
      inputWaitingHookExec: { command: "node", args: ["cli.mjs", "hook", "attention"] },
      backgroundReportHookExec: { command: "node", args: ["cli.mjs", "hook", "background-report"] },
    });

    const hooksJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: Record<string, unknown>;
    };
    // PreToolUse에는 입력 대기 신호만 남는다 — 위임 디스패치 게이트는 퇴역했다(정체성 선택은
    // delegation 스킬의 의미 정책, 철자와 로스터는 gateway_models 소유).
    expect(hooksJson.hooks.PreToolUse).toEqual([
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: "node", args: ["cli.mjs", "hook", "attention"] }] },
    ]);
    expect(JSON.stringify(hooksJson)).not.toContain("gate-delegation");
    expect(hooksJson.hooks.PostToolUse).toEqual([{
      matcher: "Workflow",
      hooks: [{
        type: "command",
        command: process.execPath,
        args: ["${CLAUDE_PLUGIN_ROOT}/hooks/fleet-gateway-model-guard.mjs", "workflow-receipt"],
      }],
    }]);
    expect(hooksJson.hooks.PostToolUseFailure).toBeUndefined();
    expect(hooksJson.hooks.SessionEnd).toBeUndefined();
    expect(JSON.stringify(hooksJson)).not.toContain("Skill(fleet:delegation)");
    expect(hooksJson.hooks.SubagentStop).toEqual([
      { hooks: [{ type: "command", command: "node", args: ["cli.mjs", "hook", "background-report"] }] },
    ]);
    expect(hooksJson.hooks.Notification).toEqual([
      { matcher: "permission_prompt|elicitation_dialog", hooks: [{ type: "command", command: "node", args: ["cli.mjs", "hook", "attention"] }] },
    ]);
    const compactHook = [{
      matcher: "manual|auto",
      hooks: [{
        type: "command",
        command: process.execPath,
        args: ["${CLAUDE_PLUGIN_ROOT}/hooks/fleet-compact-event.mjs"],
      }],
    }];
    expect(hooksJson.hooks.PreCompact).toEqual(compactHook);
    expect(hooksJson.hooks.PostCompact).toEqual(compactHook);
  });

  it("wires capture, turn-start, and auto-name onto Claude UserPromptSubmit in order", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-shared-uphooks-");

    const plugin = await createAgentCliPlugin({
      ...options({ cwd, dataDir }),
      captureSessionHookExec: { command: "node", args: ["cli.mjs", "hook", "capture-session", "claude"] },
      turnStartHookExec: { command: "node", args: ["cli.mjs", "hook", "turn-start"] },
      turnEndHookExec: { command: "node", args: ["cli.mjs", "hook", "turn-end"] },
      autoNameHookExec: { command: "node", args: ["cli.mjs", "hook", "auto-name"] },
    });

    const hooksJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: Record<string, ReadonlyArray<{ readonly hooks: ReadonlyArray<{ readonly args: readonly string[] }> }>>;
    };
    const userPromptSubmit = hooksJson.hooks.UserPromptSubmit?.[0]?.hooks ?? [];
    expect(userPromptSubmit.map((hook) => hook.args[2])).toEqual(["capture-session", "turn-start", "auto-name"]);
    // 위임 라우팅은 delegation 스킬 description이 소유한다 — 매 턴 remind 주입은 렌더되지 않는다.
    expect(JSON.stringify(hooksJson.hooks.UserPromptSubmit)).not.toContain("remind");
    expect(hooksJson.hooks.Stop?.[0]?.hooks.map((hook) => hook.args[2])).toEqual(["turn-end"]);
  });

  it("renders exactly the selected on-demand skill assets", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-shared-skills-");

    const plugin = await createAgentCliPlugin(options({ cwd, dataDir }));

    const skillsRoot = path.join(plugin.pluginRoot, "skills");
    expect(readdirSync(skillsRoot).sort()).toEqual(["delegation", "professional-pushback"]);
    for (const skillName of readdirSync(skillsRoot)) {
      expect(existsSync(path.join(skillsRoot, skillName, "SKILL.md"))).toBe(true);
    }
    expect(existsSync(path.join(plugin.pluginRoot, "agents"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "fleet-compact-event.mjs"))).toBe(true);
  });

  it("renders the latest gateway roster into the shared tree", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-shared-roster-");

    const first = await createAgentCliPlugin(options({ cwd, dataDir }));
    expect(readdirSync(path.join(first.pluginRoot, "agents"))).toEqual([]);

    const second = await createAgentCliPlugin({
      ...options({ cwd, dataDir }),
      gatewayDelegationModels: [requireGatewayModel("cursor--grok-4.5")],
    });

    expect(second.pluginRoot).toBe(first.pluginRoot);
    expect(readdirSync(path.join(second.pluginRoot, "agents")).length).toBeGreaterThan(0);
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
