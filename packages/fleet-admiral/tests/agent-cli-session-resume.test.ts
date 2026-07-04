import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createCarrierRuntime } from "@dotobokuri/fleet-carriers";
import { afterEach, describe, expect, it } from "vitest";

import * as Admiral from "../src/index.js";
import { injectAgentCliProfile } from "../src/agent-cli/injection.js";
import { createAgentCliPlugin } from "../src/agent-cli/plugin/index.js";
import type { AgentCliProfile, FleetHookExec } from "../src/agent-cli/types.js";

interface TestDedicatedMcpSession {
  readonly releasedLabels: string[];
  getEndpoint(): Promise<{ readonly servers: readonly { readonly name: string; readonly url: string }[] }>;
  issueSessionToken(request: { readonly label: string; readonly cwd: string }): readonly { readonly name: string; readonly token: string }[];
  releaseSessionToken(label: string): void;
}

interface CodexPluginManifest {
  readonly version?: unknown;
  readonly hooks?: {
    readonly hooks?: {
      readonly UserPromptSubmit?: readonly {
        readonly hooks?: readonly {
          readonly args?: unknown;
          readonly command?: unknown;
          readonly type?: unknown;
        }[];
      }[];
    };
  };
}

const tempDirs: string[] = [];
const CODEX_FLEET_PROFILE_MARKER = "# Fleet-managed Codex profile";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent CLI session resume and capture hooks", () => {
  it("places Claude --resume before Fleet injection flags", async () => {
    const root = createTempRoot("fleet-admiral-claude-resume-");
    const profile = baseProfile("claude", {
      args: ["--model", "claude-opus"],
      cwd: root,
      env: { HOME: root },
    });
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      hookExec: hookExec("node", ["cli.js", "hook", "subagents-context"]),
      resumeSessionId: "claude-session-123",
    }));

    expect(injected.args.slice(0, 4)).toEqual(["--model", "claude-opus", "--resume", "claude-session-123"]);
    expect(indexOfSequence(injected.args, ["--resume", "claude-session-123"])).toBeLessThan(indexOfSequence(injected.args, ["--system-prompt-file"]));
    expect(indexOfSequence(injected.args, ["--resume", "claude-session-123"])).toBeLessThan(indexOfSequence(injected.args, ["--plugin-dir"]));
    expect(indexOfSequence(injected.args, ["--resume", "claude-session-123"])).toBeLessThan(indexOfSequence(injected.args, ["--mcp-config"]));
    expect(indexOfSequence(injected.args, ["--resume", "claude-session-123"])).toBeLessThan(indexOfSequence(injected.args, ["--dangerously-skip-permissions"]));
  });

  it("places Codex resume after bin prefix and before global/profile/config flags", async () => {
    const root = createTempRoot("fleet-admiral-codex-resume-");
    const codexHome = path.join(root, "codex-home");
    const profile = baseProfile("codex", {
      args: ["/shim/codex", "--no-alt-screen", "--model", "gpt-5.4"],
      binPrefixArgs: ["/shim/codex"],
      cwd: root,
      env: { CODEX_HOME: codexHome, HOME: root },
    });
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      captureSessionHookExec: hookExec("node", ["console.js", "hook", "capture-session", "codex"]),
      resumeSessionId: "codex-session-456",
    }));
    const profileName = injected.args[injected.args.indexOf("--profile") + 1];
    const profilePath = path.join(codexHome, "fleet.config.toml");
    const toml = readFileSync(profilePath, "utf8");

    expect(profileName).toBe("fleet");
    expect(injected.args.slice(0, 6)).toEqual(["/shim/codex", "resume", "codex-session-456", "--no-alt-screen", "--model", "gpt-5.4"]);
    expect(indexOfSequence(injected.args, ["resume", "codex-session-456"])).toBeLessThan(indexOfSequence(injected.args, ["--no-alt-screen"]));
    expect(indexOfSequence(injected.args, ["resume", "codex-session-456"])).toBeLessThan(indexOfSequence(injected.args, ["--profile"]));
    expect(indexOfSequence(injected.args, ["resume", "codex-session-456"])).toBeLessThan(indexOfSequence(injected.args, ["-c"]));
    expect(indexOfSequence(injected.args, ["resume", "codex-session-456"])).toBeLessThan(indexOfSequence(injected.args, ["--enable"]));
    expect(indexOfSequence(injected.args, ["--enable", "hooks"])).toBeGreaterThan(indexOfSequence(injected.args, ["resume", "codex-session-456"]));
    expect(injected.args).not.toContain("--dangerously-bypass-hook-trust");
    expect(toml).toContain("[features]\nhooks = true");
    expect(toml).toContain("[hooks]\n");
    expect(toml).toContain('UserPromptSubmit = [{ hooks = [{ type = "command", command = "\'node\' \'console.js\' \'hook\' \'capture-session\' \'codex\'" }] }]');
    expect(toml).not.toContain("args =");
  });

  it("exports createSessionCaptureHookExec from the root only", () => {
    const exec = Admiral.createSessionCaptureHookExec({
      entryPath: "/tmp/fleet-console/src/cli.ts",
      provider: "codex",
      tsxLoader: "/tmp/fleet-console/node_modules/tsx/dist/loader.mjs",
    });
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      readonly exports?: Record<string, unknown>;
    };

    expect(exec).toEqual({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL("/tmp/fleet-console/node_modules/tsx/dist/loader.mjs").href,
        "/tmp/fleet-console/src/cli.ts",
        "hook",
        "capture-session",
        "codex",
      ],
    });
    expect(packageJson.exports && Object.keys(packageJson.exports)).toEqual(["."]);
    expect(packageJson.exports).not.toHaveProperty("./agent-cli/session-capture-hook");
  });

  it("creates capture hook exec without a tsx loader for JavaScript entries", () => {
    const exec = Admiral.createSessionCaptureHookExec({
      entryPath: "/tmp/fleet-console/dist/cli.mjs",
      execPath: "/usr/local/bin/node",
      provider: "claude",
    });

    expect(exec).toEqual({
      command: "/usr/local/bin/node",
      args: ["/tmp/fleet-console/dist/cli.mjs", "hook", "capture-session", "claude"],
    });
  });

  it("renders Claude capture on UserPromptSubmit and subagents-context on SessionStart", async () => {
    const root = createTempRoot("fleet-admiral-claude-hooks-");
    const dataDir = path.join(root, "data");
    const plugin = await createAgentCliPlugin({
      captureSessionHookExec: hookExec("node", ["console.js", "hook", "capture-session", "claude"]),
      claudeDefinitions: [],
      cliId: "claude",
      cwd: root,
      dataDir,
      hookExec: hookExec("node", ["console.js", "hook", "subagents-context"]),
      withMarketplaceLock: async (_target, fn) => fn(),
    });
    const hooksJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: {
        readonly SessionStart: readonly { readonly hooks: readonly unknown[] }[];
        readonly UserPromptSubmit: readonly { readonly hooks: readonly unknown[] }[];
      };
    };
    const codexPluginJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, ".codex-plugin", "plugin.json"), "utf8")) as CodexPluginManifest;

    expect(hooksJson.hooks.SessionStart).toHaveLength(1);
    expect(hooksJson.hooks.SessionStart[0]?.hooks).toEqual([
      { args: ["console.js", "hook", "subagents-context"], command: "node", type: "command" },
    ]);
    expect(hooksJson.hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooksJson.hooks.UserPromptSubmit[0]?.hooks).toEqual([
      { args: ["console.js", "hook", "capture-session", "claude"], command: "node", type: "command" },
    ]);
    expect(codexPluginJson.hooks).toBeUndefined();
  });

  it("writes Codex UserPromptSubmit capture command in the fixed Fleet profile without plugin inline hooks", async () => {
    const root = createTempRoot("fleet-admiral-codex-hooks-");
    const codexHome = path.join(root, "codex-home");
    const profile = baseProfile("codex", {
      args: ["--no-alt-screen"],
      cwd: root,
      env: { CODEX_HOME: codexHome, HOME: root },
    });
    const captureSessionHookExec = hookExec("/opt/fleet node", ["console path.js", "hook", "capture-session", "codex"]);
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      captureSessionHookExec,
    }));
    const profileName = injected.args[injected.args.indexOf("--profile") + 1];
    const profilePath = path.join(codexHome, "fleet.config.toml");
    const toml = readFileSync(profilePath, "utf8");
    const pluginJson = JSON.parse(readFileSync(path.join(root, "data", "marketplace", "plugins", "fleet", ".codex-plugin", "plugin.json"), "utf8")) as CodexPluginManifest;

    expect(profileName).toBe("fleet");
    expect(readdirSync(codexHome).filter((entry) => entry.endsWith(".config.toml"))).toEqual(["fleet.config.toml"]);
    expect(indexOfSequence(injected.args, ["--enable", "hooks"])).toBeGreaterThanOrEqual(0);
    expect(injected.args).not.toContain("--dangerously-bypass-hook-trust");
    expect(toml).toContain("[features]\nhooks = true");
    expect(toml).toContain("[hooks]\n");
    expect(toml).toContain('UserPromptSubmit = [{ hooks = [{ type = "command", command = "\'/opt/fleet node\' \'console path.js\' \'hook\' \'capture-session\' \'codex\'" }] }]');
    expect(toml).not.toContain("args =");
    expect(pluginJson.hooks).toBeUndefined();
    expect(pluginJson.version).toMatch(/^0\.0\.0\+[0-9a-f]{12}$/);
    expect(toml).not.toContain("SessionStart =");
    expect(toml).not.toContain("subagents-context");
  });

  it("preserves Codex hook trust state while rewriting the fixed Fleet profile", async () => {
    const root = createTempRoot("fleet-admiral-codex-trust-state-");
    const codexHome = path.join(root, "codex-home");
    const profilePath = path.join(codexHome, "fleet.config.toml");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(profilePath, [
      CODEX_FLEET_PROFILE_MARKER,
      'developer_instructions = """',
      "old doctrine",
      '"""',
      "",
      '[hooks.state."/Users/sbluemin/.codex/fleet.config.toml:user_prompt_submit:0:0"]',
      'trusted_hash = "sha256:user-prompt-submit"',
      "",
      '[plugins."stale@marketplace"]',
      "enabled = true",
      "",
      '[hooks.state."/Users/sbluemin/.codex/fleet.config.toml:stop:0:0"]',
      'trusted_hash = "sha256:stop"',
      "",
    ].join("\n"), { encoding: "utf8" });
    const profile = baseProfile("codex", {
      args: ["--no-alt-screen"],
      cwd: root,
      env: { CODEX_HOME: codexHome, HOME: root },
    });

    await injectAgentCliProfile(profile, baseInjectOptions(root, {
      captureSessionHookExec: hookExec("node", ["console.js", "hook", "capture-session", "codex"]),
    }));
    const toml = readFileSync(profilePath, "utf8");

    expect(toml).toContain("[hooks]\n");
    expect(toml).toContain("[hooks.state.\"/Users/sbluemin/.codex/fleet.config.toml:user_prompt_submit:0:0\"]");
    expect(toml).toContain('trusted_hash = "sha256:user-prompt-submit"');
    expect(toml).toContain("[hooks.state.\"/Users/sbluemin/.codex/fleet.config.toml:stop:0:0\"]");
    expect(toml).toContain('trusted_hash = "sha256:stop"');
    expect(toml).not.toContain('[plugins."stale@marketplace"]');
  });

  it("does not preserve hook trust state from a non-Fleet fixed profile", async () => {
    const root = createTempRoot("fleet-admiral-codex-user-profile-");
    const codexHome = path.join(root, "codex-home");
    const profilePath = path.join(codexHome, "fleet.config.toml");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(profilePath, [
      "# User-managed Codex profile",
      "[features]",
      "hooks = true",
      "",
      '[hooks.state."/Users/sbluemin/.codex/fleet.config.toml:user_prompt_submit:0:0"]',
      'trusted_hash = "sha256:user-managed"',
      "",
    ].join("\n"), { encoding: "utf8" });
    const profile = baseProfile("codex", {
      args: ["--no-alt-screen"],
      cwd: root,
      env: { CODEX_HOME: codexHome, HOME: root },
    });

    await injectAgentCliProfile(profile, baseInjectOptions(root, {
      captureSessionHookExec: hookExec("node", ["console.js", "hook", "capture-session", "codex"]),
    }));
    const toml = readFileSync(profilePath, "utf8");

    expect(toml.startsWith(CODEX_FLEET_PROFILE_MARKER)).toBe(true);
    expect(toml).not.toContain("[hooks.state.");
    expect(toml).not.toContain("trusted_hash");
  });
});

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

function baseProfile(
  id: AgentCliProfile["id"],
  options: {
    readonly args: readonly string[];
    readonly binPrefixArgs?: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  },
): AgentCliProfile {
  return {
    args: options.args,
    bin: id,
    ...(options.binPrefixArgs ? { binPrefixArgs: options.binPrefixArgs } : {}),
    cwd: options.cwd,
    env: options.env,
    id,
    label: id,
    terminalName: "xterm-256color",
  };
}

function baseInjectOptions(
  root: string,
  overrides: {
    readonly captureSessionHookExec?: FleetHookExec;
    readonly hookExec?: FleetHookExec;
    readonly resumeSessionId?: string;
  } = {},
): Parameters<typeof injectAgentCliProfile>[1] {
  return {
    buildSystemPrompt: () => "Fleet doctrine",
    carrierRuntime: createCarrierRuntime(),
    codexCommandRunner: () => ({ status: 0, stderr: "", stdout: "" }),
    dataDir: path.join(root, "data"),
    dedicatedMcpSession: createDedicatedMcpSession(),
    replaceSystemPrompt: true,
    ...(overrides.captureSessionHookExec ? { captureSessionHookExec: overrides.captureSessionHookExec } : {}),
    ...(overrides.hookExec ? { hookExec: overrides.hookExec } : {}),
    ...(overrides.resumeSessionId ? { resumeSessionId: overrides.resumeSessionId } : {}),
    withMarketplaceLock: async (_target, fn) => fn(),
  };
}

function createDedicatedMcpSession(): TestDedicatedMcpSession {
  const releasedLabels: string[] = [];
  return {
    releasedLabels,
    async getEndpoint() {
      return { servers: [{ name: "fleet", url: "http://127.0.0.1:48123/mcp" }] };
    },
    issueSessionToken() {
      return [{ name: "fleet", token: "token-123" }];
    },
    releaseSessionToken(label: string) {
      releasedLabels.push(label);
    },
  };
}

function hookExec(command: string, args: readonly string[]): FleetHookExec {
  return { args, command };
}

function indexOfSequence(values: readonly string[], sequence: readonly string[]): number {
  const index = values.findIndex((_, candidateIndex) =>
    sequence.every((expected, sequenceIndex) => values[candidateIndex + sequenceIndex] === expected));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}
