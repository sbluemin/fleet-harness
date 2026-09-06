import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findGatewayModel } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FLEET_PLUGIN_NAME,
  GATEWAY_DISABLED_CLAUDE_SKILLS,
  getAgentCliIds,
  getAgentCliMetadata,
  parseAgentCliId,
  GENERAL_PURPOSE_AGENT_PROMPT,
  buildDisabledSkillOverrides,
  buildGatewayAgentFiles,
  buildGatewayCustomAgents,
  injectAgentCliProfile,
  resolveAgentCliProfile,
  toGatewayAgentName,
  type AgentCliProfile,
  type FleetHookExec,
} from "../src/index.js";
import { buildClaudeGatewayArgs } from "../src/agent-cli/builders/claude.js";
import type { AgentCliInjectionContext } from "../src/agent-cli/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("claude-gateway profile", () => {
  it("is the only published Agent CLI and normalizes exact retired aliases", () => {
    expect(getAgentCliIds()).toEqual(["claude"]);
    expect(getAgentCliMetadata()).toEqual([{ id: "claude", label: "Claude" }]);
    expect(parseAgentCliId("claude")).toBe("claude");
    expect(parseAgentCliId("claude-native")).toBe("claude");
    expect(parseAgentCliId("claude-gateway")).toBe("claude");
    expect(() => parseAgentCliId("claude-native-extra")).toThrow(/Unsupported agent CLI/);
  });

  it("uses Claude Code while preserving inherited Anthropic credentials for built-in models", async () => {
    const profile = await resolveAgentCliProfile({
      ANTHROPIC_API_KEY: "api-secret",
      ANTHROPIC_AUTH_TOKEN: "bearer-secret",
      CLAUDE_BIN: process.execPath,
      KEEP_ME: "yes",
    }, "/tmp", {
      cliId: "claude",
      model: "claude-gateway--cursor-auto",
      effort: "xhigh",
    });

    expect(profile).toMatchObject({
      args: ["--model", "claude-gateway--cursor-auto", "--effort", "xhigh"],
      bin: process.execPath,
      id: "claude",
      label: "Claude",
      renameCommand: "/rename",
    });
    expect(profile.env).toMatchObject({
      ANTHROPIC_API_KEY: "api-secret",
      ANTHROPIC_AUTH_TOKEN: "bearer-secret",
      KEEP_ME: "yes",
    });
  });

  it("caps subagent spawn depth so a delegated worker cannot re-delegate", async () => {
    const profile = await resolveAgentCliProfile({
      CLAUDE_BIN: process.execPath,
    }, "/tmp", { cliId: "claude" });

    // 1이면 세션 자신만 Agent를 부를 수 있다 — 서브에이전트의 도구 목록에서 Agent가 사라진다.
    expect(profile.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe("1");
  });
});

describe("claude-gateway argument composition", () => {

  it("carries the permission opt-in from launch options all the way into argv", async () => {
    const root = createTempRoot("fleet-admiral-gateway-permission-optin-");
    const profile = baseProfile("claude", { args: [], cwd: root, env: { HOME: root } });
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      claudeCodeSkipPermissions: true,
    }));

    try {
      expect(injected.args).toContain("--dangerously-skip-permissions");
      expect(injected.args).not.toContain("--permission-mode");
    } finally {
      injected.cleanup?.();
    }
  });
});

describe("claude-gateway disabled skills", () => {
  it("turns the built-in claude-api skill off through --settings", async () => {
    const root = createTempRoot("fleet-admiral-gateway-skills-");
    const profile = baseProfile("claude", {
      args: [],
      cwd: root,
      env: { HOME: root },
    });

    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root));

    const settingsIndex = injected.args.indexOf("--settings");
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    const settingsJson = injected.args[settingsIndex + 1];
    expect(typeof settingsJson).toBe("string");
    const settings = JSON.parse(settingsJson as string) as {
      skillOverrides?: Record<string, string>;
    };
    expect(settings.skillOverrides).toEqual({ "claude-api": "off" });
    // `off`만 목록과 슬래시 호출 양쪽에서 감춘다. name-only/user-invocable-only는
    // 서브에이전트에게 이름이 남거나 모델 목록에 그대로 실린다.
    for (const override of Object.values(settings.skillOverrides ?? {})) {
      expect(override).toBe("off");
    }
    // 이 설정은 Fleet이 강제하는 키만 실어야 한다. 사용자·프로젝트 설정을 이 자리에서
    // 덮으면 flag 소스가 가장 세서 되돌릴 방법이 없다.
    expect(Object.keys(settings)).toEqual(["skillOverrides"]);

    injected.cleanup?.();
  });
});

function requireGatewayModel(id: string) {
  const model = findGatewayModel(id);
  if (!model) throw new Error(`missing gateway model fixture: ${id}`);
  return model;
}

/**
 * 세션이 실제로 적재하는 정의가 놓인 자리. argv의 `--plugin-dir`를 따라가야 렌더가 실제
 * 스폰이 가리키는 곳에 떨어졌는지까지 확인된다 — 경로를 따로 계산하면 그 연결이 빠진다.
 */
function agentsDirOf(profile: AgentCliProfile): string {
  const index = profile.args.indexOf("--plugin-dir");
  expect(index).toBeGreaterThanOrEqual(0);
  return path.join(profile.args[index + 1]!, "agents");
}

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function baseProfile(
  id: AgentCliProfile["id"],
  options: {
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  },
): AgentCliProfile {
  return {
    args: options.args,
    bin: id,
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
    readonly gatewayDelegationModels?: Parameters<typeof injectAgentCliProfile>[1]["gatewayDelegationModels"];
    readonly captureSessionHookExec?: FleetHookExec;
    readonly claudeCodeSystemPrompt?: "on" | "off";
    readonly claudeCodeSkipPermissions?: boolean;
  } = {},
): Parameters<typeof injectAgentCliProfile>[1] {
  return {
    dataDir: path.join(root, "data"),
    ...(overrides.claudeCodeSystemPrompt ? { claudeCodeSystemPrompt: overrides.claudeCodeSystemPrompt } : {}),
    ...(overrides.claudeCodeSkipPermissions !== undefined
      ? { claudeCodeSkipPermissions: overrides.claudeCodeSkipPermissions }
      : {}),
    dedicatedMcpSession: {
      async getEndpoint() {
        return { servers: [{ name: "fleet", url: "http://127.0.0.1:48123/mcp" }] };
      },
      issueSessionToken() {
        return [{ name: "fleet", token: "token-123" }];
      },
      releaseSessionToken() {},
    },
    ...(overrides.captureSessionHookExec ? { captureSessionHookExec: overrides.captureSessionHookExec } : {}),
    ...(overrides.gatewayDelegationModels ? { gatewayDelegationModels: overrides.gatewayDelegationModels } : {}),
  };
}
