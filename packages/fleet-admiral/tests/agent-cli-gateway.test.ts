import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findGatewayModel } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

import {
  GATEWAY_DISABLED_CLAUDE_SKILLS,
  GENERAL_PURPOSE_AGENT_PROMPT,
  buildDisabledSkillOverrides,
  buildGatewayCustomAgents,
  injectAgentCliProfile,
  resolveAgentCliProfile,
  toGatewayAgentName,
  type AgentCliProfile,
  type FleetHookExec,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("claude-gateway profile", () => {
  it("uses Claude Code while stripping inherited provider credentials", async () => {
    const profile = await resolveAgentCliProfile({
      ANTHROPIC_API_KEY: "api-secret",
      ANTHROPIC_AUTH_TOKEN: "bearer-secret",
      CLAUDE_BIN: process.execPath,
      KEEP_ME: "yes",
    }, "/tmp", {
      cliId: "claude-gateway",
      model: "claude-gateway--cursor-auto",
    });

    expect(profile).toMatchObject({
      args: ["--model", "claude-gateway--cursor-auto"],
      bin: process.execPath,
      id: "claude-gateway",
      label: "Claude (Gateway)",
      renameCommand: "/rename",
    });
    expect(profile.env.KEEP_ME).toBe("yes");
    expect(profile.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(profile.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });
});

describe("claude-gateway custom agents", () => {
  it("uses the Fleet mode-switch GP prompt, not Claude Code thorough-search GP", () => {
    expect(GENERAL_PURPOSE_AGENT_PROMPT).toContain("Fleet execution agent");
    expect(GENERAL_PURPOSE_AGENT_PROMPT).toContain("Pick ONE mode");
    expect(GENERAL_PURPOSE_AGENT_PROMPT).toContain("binding contracts");
    // depth는 Vanguard의 carrier_dispatch request-block 태그다. gateway 세션은 캐리어 도구를
    // 받지 않아 호스트가 채울 수 없으므로, 프롬프트가 참조할 수 없는 어휘로 남지 않게 한다.
    expect(GENERAL_PURPOSE_AGENT_PROMPT).not.toMatch(/depth=/);
    expect(GENERAL_PURPOSE_AGENT_PROMPT).not.toMatch(/search broadly/i);
    expect(GENERAL_PURPOSE_AGENT_PROMPT).not.toMatch(/Be thorough/i);
    expect(GENERAL_PURPOSE_AGENT_PROMPT).not.toMatch(/multiple search strategies/i);
    expect(GENERAL_PURPOSE_AGENT_PROMPT).not.toContain("<report>");
    expect(GENERAL_PURPOSE_AGENT_PROMPT).not.toContain("carrier_jobs");
  });

  it("expands exposed models into claude-gateway-- agents with GP prompt", () => {
    const model = requireGatewayModel("cursor--claude-opus-5");
    const agents = buildGatewayCustomAgents([model]);
    const names = Object.keys(agents);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const agent = agents[name]!;
      expect(name.startsWith("gw-")).toBe(false);
      expect(name.startsWith("cursor-")).toBe(true);
      expect(agent.model.startsWith("claude-gateway--")).toBe(true);
      expect(agent.prompt).toBe(GENERAL_PURPOSE_AGENT_PROMPT);
      expect(agent.description).toContain("gateway_models");
      // capability class 는 판단석 배정의 prior 다. 설명 첫 문장에서 사라지면 호스트는
      // 정체성을 고르는 순간(gateway_models 재조회 전) 등급을 볼 수 없다.
      expect(agent.description).toContain("flagship class");
      // 호스트가 읽는 유일한 선택 신호이므로 프롬프트와 같은 모드 어휘를 써야 한다.
      expect(agent.description).toContain("recon, decide, implement, or verify");
      expect(agent.description).not.toMatch(/researching complex questions/i);
      // 이름과 모델 id는 철자가 다르고 서로 대체되지 않는다. 이 문장이 사라지면 둘을 잇는
      // 자리가 없어지고, 이름을 요구하는 자리에 모델 id를 넣는 실패로 되돌아간다.
      expect(agent.description).toContain(`agent type name ${name}`);
    }
    const withEffort = names.find((name) => name.endsWith("-high"));
    expect(withEffort).toBeDefined();
    expect(agents[withEffort!]!.effort).toBe("high");
    expect(toGatewayAgentName(agents[withEffort!]!.model, "high")).toBe(withEffort);
  });

  it("carries each model's own capability class, light tiers included", () => {
    const flash = requireGatewayModel("opencode--deepseek-v4-flash");
    const agents = buildGatewayCustomAgents([flash]);
    const definitions = Object.values(agents);
    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      // light 가 flagship 으로 읽히면 판단석 배정의 prior 가 통째로 뒤집힌다.
      expect(definition.description).toContain("light class");
      expect(definition.description).not.toContain("flagship class");
    }
  });

  it("injects --agents only for claude-gateway, and never disables a built-in agent", async () => {
    const root = createTempRoot("fleet-admiral-gateway-agents-");
    const model = requireGatewayModel("cursor--claude-opus-5");
    const gateway = baseProfile("claude-gateway", {
      args: [],
      cwd: root,
      env: { HOME: root },
    });
    const native = baseProfile("claude-native", {
      args: [],
      cwd: root,
      env: { HOME: root },
    });

    const injectedGateway = await injectAgentCliProfile(gateway, baseInjectOptions(root, {
      gatewayExposedModels: [model],
    }));
    const injectedNative = await injectAgentCliProfile(native, baseInjectOptions(root, {
      gatewayExposedModels: [model],
    }));

    // 게이트웨이 정의는 내장 Agent를 대체하지 않고 그 옆에 놓인다. 내장을 끄면
    // 상속(unpinned) 위임이 막혀 세션 자신의 모델로 도는 작업을 만들 수 없다.
    expect(injectedGateway.args).not.toContain("--disallowedTools");

    const agentsIndex = injectedGateway.args.indexOf("--agents");
    expect(agentsIndex).toBeGreaterThanOrEqual(0);
    const agentsJson = injectedGateway.args[agentsIndex + 1];
    expect(typeof agentsJson).toBe("string");
    const agents = JSON.parse(agentsJson as string) as Record<string, {
      model: string;
      prompt: string;
      effort?: string;
    }>;
    expect(Object.keys(agents).length).toBeGreaterThan(0);
    for (const agent of Object.values(agents)) {
      expect(agent.model.startsWith("claude-gateway--")).toBe(true);
      expect(agent.prompt).toBe(GENERAL_PURPOSE_AGENT_PROMPT);
    }

    expect(injectedNative.args).not.toContain("--disallowedTools");
    expect(injectedNative.args).not.toContain("--agents");

    injectedGateway.cleanup?.();
    injectedNative.cleanup?.();
  });

  it("injects neither flag when no gateway models are exposed", async () => {
    const root = createTempRoot("fleet-admiral-gateway-agents-empty-");
    const profile = baseProfile("claude-gateway", {
      args: [],
      cwd: root,
      env: { HOME: root },
    });
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root));
    // 노출 모델이 없으면 게이트웨이 세션은 내장 Agent만 가진 평범한 세션이다.
    expect(injected.args).not.toContain("--agents");
    expect(injected.args).not.toContain("--disallowedTools");
    injected.cleanup?.();
  });
});

describe("claude-gateway disabled skills", () => {
  it("turns the built-in claude-api skill off through --settings", async () => {
    const root = createTempRoot("fleet-admiral-gateway-skills-");
    const profile = baseProfile("claude-gateway", {
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

  it("leaves native Claude sessions untouched", async () => {
    const root = createTempRoot("fleet-admiral-gateway-skills-other-");
    const native = baseProfile("claude-native", { args: [], cwd: root, env: { HOME: root } });

    const injectedNative = await injectAgentCliProfile(native, baseInjectOptions(root));

    expect(injectedNative.args).not.toContain("--settings");

    injectedNative.cleanup?.();
  });

  it("keeps the roster non-empty so the flag is never a no-op", () => {
    expect(GATEWAY_DISABLED_CLAUDE_SKILLS).toContain("claude-api");
    expect(buildDisabledSkillOverrides(GATEWAY_DISABLED_CLAUDE_SKILLS)).toBeDefined();
    expect(buildDisabledSkillOverrides([])).toBeUndefined();
  });
});

function requireGatewayModel(id: string) {
  const model = findGatewayModel(id);
  if (!model) throw new Error(`missing gateway model fixture: ${id}`);
  return model;
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
    readonly gatewayExposedModels?: Parameters<typeof injectAgentCliProfile>[1]["gatewayExposedModels"];
    readonly captureSessionHookExec?: FleetHookExec;
  } = {},
): Parameters<typeof injectAgentCliProfile>[1] {
  return {
    buildSystemPrompt: () => "Fleet doctrine",
    dataDir: path.join(root, "data"),
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
    ...(overrides.gatewayExposedModels ? { gatewayExposedModels: overrides.gatewayExposedModels } : {}),
    withMarketplaceLock: async (_target, fn) => fn(),
  };
}
