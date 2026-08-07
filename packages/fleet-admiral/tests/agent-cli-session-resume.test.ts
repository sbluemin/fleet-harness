import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import * as Admiral from "../src/index.js";
import { buildHostShellCommand, buildPowerShellCommand, escapeTomlBasicString } from "../src/agent-cli/builders/toml.js";
import { injectAgentCliProfile } from "../src/agent-cli/injection.js";
import { createAgentCliPlugin } from "../src/agent-cli/plugin/index.js";
import type { AgentCliProfile, FleetHookExec } from "../src/agent-cli/types.js";

interface TestDedicatedMcpSession {
  readonly issuedRequests: Array<{ readonly label: string; readonly cwd: string }>;
  readonly releasedLabels: string[];
  getEndpoint(): Promise<{ readonly servers: readonly { readonly name: string; readonly url: string }[] }>;
  issueSessionToken(request: { readonly label: string; readonly cwd: string }): readonly { readonly name: string; readonly token: string }[];
  releaseSessionToken(label: string): void;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent CLI session resume and capture hooks", () => {
  it("defaults metaphor off and forwards explicit opt-in to the prompt builder", async () => {
    const observed: Array<{ enableMetaphor: boolean; doctrine: string }> = [];

    for (const enableMetaphor of [undefined, true] as const) {
      const root = createTempRoot(`fleet-admiral-metaphor-${enableMetaphor ?? false}-`);
      const profile = baseProfile("claude", {
        args: [],
        cwd: root,
        env: { HOME: root },
      });
      const injected = await injectAgentCliProfile(profile, baseInjectOptions(root, {
        buildSystemPrompt: (value) => {
          const options = typeof value === "boolean"
            ? { enableMetaphor: value, doctrine: "classic" as const }
            : value;
          observed.push({ enableMetaphor: options.enableMetaphor, doctrine: options.doctrine ?? "classic" });
          return "Fleet doctrine";
        },
        ...(enableMetaphor === undefined ? {} : { enableMetaphor }),
      }));
      injected.cleanup?.();
    }

    expect(observed).toEqual([
      { enableMetaphor: false, doctrine: "classic" },
      { enableMetaphor: true, doctrine: "classic" },
    ]);
  });

  it("selects gateway doctrine from claude-gateway profile id", async () => {
    const observed: Array<{ enableMetaphor: boolean; doctrine: string }> = [];
    const root = createTempRoot("fleet-admiral-gateway-doctrine-");
    const profile = baseProfile("claude-gateway", {
      args: [],
      cwd: root,
      env: { HOME: root },
    });
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      buildSystemPrompt: (value) => {
        const options = typeof value === "boolean"
          ? { enableMetaphor: value, doctrine: "classic" as const }
          : value;
        observed.push({ enableMetaphor: options.enableMetaphor, doctrine: options.doctrine ?? "classic" });
        return "Fleet doctrine";
      },
      enableMetaphor: true,
    }));
    injected.cleanup?.();

    expect(observed).toEqual([{ enableMetaphor: true, doctrine: "gateway" }]);
  });

  it("places Claude --resume before Fleet injection flags", async () => {
    const root = createTempRoot("fleet-admiral-claude-resume-");
    const profile = baseProfile("claude", {
      args: ["--model", "claude-opus"],
      cwd: root,
      env: { HOME: root },
    });
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      resumeSessionId: "claude-session-123",
    }));

    expect(injected.args.slice(0, 4)).toEqual(["--model", "claude-opus", "--resume", "claude-session-123"]);
    expect(indexOfSequence(injected.args, ["--resume", "claude-session-123"])).toBeLessThan(indexOfSequence(injected.args, ["--append-system-prompt-file"]));
    expect(indexOfSequence(injected.args, ["--resume", "claude-session-123"])).toBeLessThan(indexOfSequence(injected.args, ["--plugin-dir"]));
    expect(indexOfSequence(injected.args, ["--resume", "claude-session-123"])).toBeLessThan(indexOfSequence(injected.args, ["--mcp-config"]));
    expect(indexOfSequence(injected.args, ["--resume", "claude-session-123"])).toBeLessThan(indexOfSequence(injected.args, ["--dangerously-skip-permissions"]));
  });



  it("exports createSessionCaptureHookExec from the root only", () => {
    const exec = Admiral.createSessionCaptureHookExec({
      entryPath: "/tmp/fleet-console/src/cli.ts",
      provider: "claude",
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
        "claude",
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

  it("renders the background report on both stop events through profile injection", async () => {
    const root = createTempRoot("fleet-admiral-background-hooks-");
    const profile = baseProfile("claude", {
      args: [],
      cwd: root,
      env: { HOME: root },
    });
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      turnEndHookExec: hookExec("node", ["console.js", "hook", "turn-end"]),
      backgroundReportHookExec: hookExec("node", ["console.js", "hook", "background-report"]),
    }));
    const pluginRootIndex = injected.args.indexOf("--plugin-dir") + 1;
    const pluginRoot = injected.args[pluginRootIndex];
    expect(pluginRootIndex).toBeGreaterThan(0);
    expect(typeof pluginRoot).toBe("string");
    const hooksJson = JSON.parse(readFileSync(path.join(pluginRoot as string, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: Record<string, unknown>;
    };

    // 살아 있는 작업 목록은 Stop과 SubagentStop payload에만 실린다. 두 이벤트 모두에서 보고해야
    // 워크플로우가 끝난 뒤의 해제까지 닫힌다.
    expect(hooksJson.hooks.Stop).toEqual([
      { hooks: [
        { type: "command", command: "node", args: ["console.js", "hook", "turn-end"] },
        { type: "command", command: "node", args: ["console.js", "hook", "background-report"] },
      ] },
    ]);
    expect(hooksJson.hooks.SubagentStop).toEqual([
      { hooks: [{ type: "command", command: "node", args: ["console.js", "hook", "background-report"] }] },
    ]);
    expect(hooksJson.hooks.PreToolUse).toBeUndefined();
    injected.cleanup?.();
  });

  it("renders Claude capture on UserPromptSubmit", async () => {
    const root = createTempRoot("fleet-admiral-claude-hooks-");
    const dataDir = path.join(root, "data");
    const plugin = await createAgentCliPlugin({
      captureSessionHookExec: hookExec("node", ["console.js", "hook", "capture-session", "claude"]),
      cliId: "claude",
      cwd: root,
      dataDir,
      withMarketplaceLock: async (_target, fn) => fn(),
    });
    const hooksJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: {
        readonly SessionStart?: readonly { readonly hooks: readonly unknown[] }[];
        readonly UserPromptSubmit: readonly { readonly hooks: readonly unknown[] }[];
      };
    };

    expect(hooksJson.hooks.SessionStart).toBeUndefined();
    expect(hooksJson.hooks.UserPromptSubmit).toHaveLength(1);
    expect(hooksJson.hooks.UserPromptSubmit[0]?.hooks).toEqual([
      { args: ["console.js", "hook", "capture-session", "claude"], command: "node", type: "command" },
    ]);
    expect(existsSync(path.join(plugin.pluginRoot, ".codex-plugin", "plugin.json"))).toBe(false);
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
    readonly buildSystemPrompt?: Parameters<typeof injectAgentCliProfile>[1]["buildSystemPrompt"];
    readonly autoNameHookExec?: FleetHookExec;
    readonly backgroundReportHookExec?: FleetHookExec;
    readonly captureSessionHookExec?: FleetHookExec;
    readonly dedicatedMcpSession?: TestDedicatedMcpSession;
    readonly enableMetaphor?: boolean;
    readonly gatewayExposedModels?: Parameters<typeof injectAgentCliProfile>[1]["gatewayExposedModels"];
    readonly inputWaitingHookExec?: FleetHookExec;
    readonly resumeSessionId?: string;
    readonly turnEndHookExec?: FleetHookExec;
    readonly turnStartHookExec?: FleetHookExec;
  } = {},
): Parameters<typeof injectAgentCliProfile>[1] {
  return {
    buildSystemPrompt: overrides.buildSystemPrompt ?? (() => "Fleet doctrine"),
    dataDir: path.join(root, "data"),
    dedicatedMcpSession: overrides.dedicatedMcpSession ?? createDedicatedMcpSession(),
    ...(overrides.autoNameHookExec ? { autoNameHookExec: overrides.autoNameHookExec } : {}),
    ...(overrides.backgroundReportHookExec ? { backgroundReportHookExec: overrides.backgroundReportHookExec } : {}),
    ...(overrides.captureSessionHookExec ? { captureSessionHookExec: overrides.captureSessionHookExec } : {}),
    ...(overrides.enableMetaphor === undefined ? {} : { enableMetaphor: overrides.enableMetaphor }),
    ...(overrides.gatewayExposedModels ? { gatewayExposedModels: overrides.gatewayExposedModels } : {}),
    ...(overrides.inputWaitingHookExec ? { inputWaitingHookExec: overrides.inputWaitingHookExec } : {}),
    ...(overrides.resumeSessionId ? { resumeSessionId: overrides.resumeSessionId } : {}),
    ...(overrides.turnEndHookExec ? { turnEndHookExec: overrides.turnEndHookExec } : {}),
    ...(overrides.turnStartHookExec ? { turnStartHookExec: overrides.turnStartHookExec } : {}),
    withMarketplaceLock: async (_target, fn) => fn(),
  };
}

function createDedicatedMcpSession(
  options: {
    readonly servers?: readonly { readonly name: string; readonly url: string }[];
    readonly tokens?: readonly { readonly name: string; readonly token: string }[];
  } = {},
): TestDedicatedMcpSession {
  const issuedRequests: Array<{ readonly label: string; readonly cwd: string }> = [];
  const releasedLabels: string[] = [];
  const servers = options.servers ?? [{ name: "fleet", url: "http://127.0.0.1:48123/mcp" }];
  const tokens = options.tokens ?? [{ name: "fleet", token: "token-123" }];
  return {
    issuedRequests,
    releasedLabels,
    async getEndpoint() {
      return { servers };
    },
    issueSessionToken(request) {
      issuedRequests.push(request);
      return tokens;
    },
    releaseSessionToken(label: string) {
      releasedLabels.push(label);
    },
  };
}

function readTextFilesRecursively(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? readTextFilesRecursively(entryPath) : [readFileSync(entryPath, "utf8")];
  });
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
