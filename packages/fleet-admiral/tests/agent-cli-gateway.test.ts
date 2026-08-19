import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
    expect(getAgentCliIds()).toEqual(["claude-gateway"]);
    expect(getAgentCliMetadata()).toEqual([{ id: "claude-gateway", label: "Claude (Gateway)" }]);
    expect(parseAgentCliId("claude")).toBe("claude-gateway");
    expect(parseAgentCliId("claude-native")).toBe("claude-gateway");
    expect(parseAgentCliId("claude-gateway")).toBe("claude-gateway");
    expect(() => parseAgentCliId("claude-native-extra")).toThrow(/Unsupported agent CLI/);
  });

  it("uses Claude Code while preserving inherited Anthropic credentials for built-in models", async () => {
    const profile = await resolveAgentCliProfile({
      ANTHROPIC_API_KEY: "api-secret",
      ANTHROPIC_AUTH_TOKEN: "bearer-secret",
      CLAUDE_BIN: process.execPath,
      KEEP_ME: "yes",
    }, "/tmp", {
      cliId: "claude-gateway",
      model: "claude-gateway--cursor-auto",
      effort: "xhigh",
    });

    expect(profile).toMatchObject({
      args: ["--model", "claude-gateway--cursor-auto", "--effort", "xhigh"],
      bin: process.execPath,
      id: "claude-gateway",
      label: "Claude (Gateway)",
      renameCommand: "/rename",
    });
    expect(profile.env).toMatchObject({
      ANTHROPIC_API_KEY: "api-secret",
      ANTHROPIC_AUTH_TOKEN: "bearer-secret",
      KEEP_ME: "yes",
    });
  });

  it("delivers ultra as Claude Code --effort ultracode", async () => {
    const profile = await resolveAgentCliProfile({
      CLAUDE_BIN: process.execPath,
    }, "/tmp", {
      cliId: "claude-gateway",
      model: "claude-gateway--codex--gpt-5.6-sol",
      effort: "ultra",
    });

    // CLI가 ultracode를 xhigh + standing orchestration으로 해석한다 — max/settings로 우회하지 않는다.
    expect(profile).toMatchObject({
      args: ["--model", "claude-gateway--codex--gpt-5.6-sol", "--effort", "ultracode"],
    });
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
    const model = requireGatewayModel("cursor--grok-4.5");
    const agents = buildGatewayCustomAgents([model]);
    const names = Object.keys(agents);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const agent = agents[name]!;
      expect(name.startsWith("gw-")).toBe(false);
      expect(name.startsWith("cursor-")).toBe(true);
      expect(agent.model.startsWith("claude-gateway--")).toBe(true);
      expect(agent.prompt).toBe(GENERAL_PURPOSE_AGENT_PROMPT);
      // description은 선택 신호가 아니라 목록 라벨이다. 정체성 선택에 필요한 사실은
      // gateway_models가 호출 시점에 보고하고, 핀 강제는 모델 가드 훅이 맡는다. 이 줄이
      // 다시 문단으로 자라면 정체성 스무 개마다 같은 표가 복제되어 세션 창에 상주한다.
      expect(agent.description.length).toBeLessThanOrEqual(48);
      expect(agent.description).not.toContain("gateway_models");
      expect(agent.description).not.toContain("class");
      expect(agent.description).not.toContain("Bench");
    }
    const withEffort = names.find((name) => name.endsWith("-high"));
    expect(withEffort).toBeDefined();
    expect(agents[withEffort!]!.effort).toBe("high");
    expect(toGatewayAgentName(agents[withEffort!]!.model, "high")).toBe(withEffort);
  });

  it("never registers an ultra identity — ultracode is a launch --effort, not a roster rung", () => {
    // 카탈로그 사다리는 max에서 끝나므로 위임 신원에도 ultra가 서지 않는다. ultracode는
    // Operation launch의 --effort ultracode 경로다.
    const model = requireGatewayModel("codex--gpt-5.6-sol");
    const agents = buildGatewayCustomAgents([model]);
    const names = Object.keys(agents);
    expect(names.some((name) => name.endsWith("-ultra"))).toBe(false);
    expect(names.some((name) => name.endsWith("-max"))).toBe(true);
    for (const name of names) expect(agents[name]!.effort).not.toBe("ultra");
  });

  it("builds identities only for the models the caller provides", () => {
    const included = requireGatewayModel("cursor--grok-4.5");
    const omittedModelId = "claude-gateway--opencode--deepseek-v4-flash";

    const agents = buildGatewayCustomAgents([included]);
    expect(Object.keys(agents).length).toBeGreaterThan(0);
    expect(Object.values(agents).map((agent) => agent.model)).not.toContain(omittedModelId);

    const files = buildGatewayAgentFiles([included]);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => !file.content.includes(omittedModelId))).toBe(true);
  });

  it("labels each identity by provider, model, and rung", () => {
    const flash = requireGatewayModel("opencode--deepseek-v4-flash");
    for (const definition of Object.values(buildGatewayCustomAgents([flash]))) {
      // 사람이 목록에서 이 줄을 알아볼 만큼만 — 공급자와 모델, 강도를 쓰는 모델이면 그 단.
      expect(definition.description).toContain("opencode/deepseek-v4-flash");
      expect(definition.description).not.toContain("claude-gateway--");
    }

    const solHigh = buildGatewayCustomAgents([requireGatewayModel("codex--gpt-5.6-sol-fast")])["codex-gpt-5-6-sol-fast-high"];
    expect(solHigh?.description).toBe("codex/gpt-5.6-sol-fast @high");
  });

  it("registers gateway identities as plugin agent files, and never disables a built-in agent", async () => {
    const root = createTempRoot("fleet-admiral-gateway-agents-");
    const model = requireGatewayModel("cursor--grok-4.5");
    const gateway = baseProfile("claude-gateway", {
      args: [],
      cwd: root,
      env: { HOME: root },
    });

    const injectedGateway = await injectAgentCliProfile(gateway, baseInjectOptions(root, {
      gatewayDelegationModels: [model],
    }));

    // 게이트웨이 정의는 내장 Agent를 대체하지 않고 그 옆에 놓인다. 내장을 끄면
    // 상속(unpinned) 위임이 막혀 세션 자신의 모델로 도는 작업을 만들 수 없다.
    expect(injectedGateway.args).not.toContain("--disallowedTools");

    // 정의가 argv에 실리면 Windows 명령줄 한도가 로스터 크기를 대신 정한다 — 정의 하나가
    // 1.9KB쯤이라 스무 개만 노출해도 프롬프트를 싣기 전에 실행이 불가능해진다.
    expect(injectedGateway.args).not.toContain("--agents");

    const files = readdirSync(agentsDirOf(injectedGateway));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      // `:`는 플러그인 스코프 구분자로 예약돼 있어, 이름에 들어간 파일은 아예 적재되지 않는다.
      expect(file).not.toContain(":");
      const content = readFileSync(path.join(agentsDirOf(injectedGateway), file), "utf8");
      expect(content.startsWith("---\n")).toBe(true);
      expect(content).toContain(`name: ${JSON.stringify(file.replace(/\.md$/u, ""))}`);
      expect(content).toContain('model: "claude-gateway--');
      expect(content).toContain(GENERAL_PURPOSE_AGENT_PROMPT);
    }
    injectedGateway.cleanup?.();
  });

  it("registers no identity when no gateway models are exposed", async () => {
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
    expect(readdirSync(agentsDirOf(injected))).toEqual([]);
    injected.cleanup?.();
  });
});

describe("claude-gateway argument composition", () => {
  it("never carries a system prompt flag while preserving gateway composition", () => {
    const args = buildClaudeGatewayArgs({
      cliId: "claude-gateway",
      mcpServers: [{ name: "fleet", endpointUrl: "http://127.0.0.1:48123/mcp", bearerToken: "token" }],
      pluginRoot: "/fleet/plugin",
      pluginRoots: ["/fleet/plugin"],
      skillOverrides: { "claude-api": "off" },
    });

    expect(args).not.toContain("--append-system-prompt-file");
    expect(args).not.toContain("--system-prompt-file");
    expect(args).toContain("--plugin-dir");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--settings");
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("restores the suppressed search tools without replacing the built-in set", () => {
    const args = buildClaudeGatewayArgs({
      cliId: "claude-gateway",
      mcpServers: [],
      pluginRoot: "/fleet/plugin",
      pluginRoots: ["/fleet/plugin"],
    });

    // 이름을 허용 목록에 올려야 억제가 풀린다. `--tools`는 내장 집합을 통째로
    // 대체하므로 두 도구를 되살리는 값이 나머지를 함께 지운다.
    const allowed = args.indexOf("--allowedTools");
    expect(allowed).toBeGreaterThanOrEqual(0);
    expect(args[allowed + 1]).toBe("Grep,Glob");
    expect(args).not.toContain("--tools");
    // 가변 인자가 값을 삼키지 않도록 바이패스 플래그가 뒤에 와야 한다.
    expect(args.indexOf("--dangerously-skip-permissions")).toBeGreaterThan(allowed + 1);
  });

  it("cleans the prompt file when plugin injection fails", async () => {
    const root = createTempRoot("fleet-admiral-gateway-injection-failure-");
    const isolatedTmp = path.join(root, "tmp");
    mkdirSync(isolatedTmp);
    vi.spyOn(os, "tmpdir").mockReturnValue(isolatedTmp);

    try {
      await expect(injectAgentCliProfile(
        {
          ...baseProfile("claude-gateway", { args: [], cwd: root, env: { HOME: root } }),
          commandLineLimit: { maxChars: 8191, via: "cmd-shim" },
          promptArgs: ["hello & world"],
        },
        {
          ...baseInjectOptions(root),
          withMarketplaceLock: async () => { throw new Error("injected marketplace failure"); },
        },
      )).rejects.toThrow("injected marketplace failure");

      expect(readdirSync(isolatedTmp)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("composes gateway assets with no system prompt flag on any path", async () => {
    const root = createTempRoot("fleet-admiral-gateway-compose-");
    const profile = baseProfile("claude-gateway", { args: [], cwd: root, env: { HOME: root } });
    const model = requireGatewayModel("cursor--grok-4.5");
    const hook: FleetHookExec = { command: process.execPath, args: ["hook"] };
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      gatewayDelegationModels: [model],
      captureSessionHookExec: hook,
    }));

    // 이 세션은 Fleet 시스템 프롬프트를 싣지 않는다. 두 플래그 중 어느 것도 argv에 없어야 한다.
    expect(injected.args).not.toContain("--append-system-prompt-file");
    expect(injected.args).not.toContain("--system-prompt-file");
    expect(injected.args).toContain("--plugin-dir");
    expect(injected.args).toContain("--mcp-config");
    expect(injected.args).toContain("--settings");
    expect(injected.args).toContain("--dangerously-skip-permissions");

    const pluginRoot = injected.args[injected.args.indexOf("--plugin-dir") + 1]!;
    const pluginJson = readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8");
    const hooksJson = JSON.parse(readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(pluginJson).toContain(FLEET_PLUGIN_NAME);
    expect(hooksJson.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe(process.execPath);
    expect(readdirSync(path.join(pluginRoot, "agents")).length).toBeGreaterThan(0);
    // 스킬 자산은 더 이상 렌더되지 않는다.
    expect(existsSync(path.join(pluginRoot, "skills"))).toBe(false);
    const settings = JSON.parse(injected.args[injected.args.indexOf("--settings") + 1]!) as { skillOverrides: Record<string, string> };
    expect(settings.skillOverrides).toEqual({ "claude-api": "off" });

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
  } = {},
): Parameters<typeof injectAgentCliProfile>[1] {
  return {
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
    ...(overrides.gatewayDelegationModels ? { gatewayDelegationModels: overrides.gatewayDelegationModels } : {}),
    withMarketplaceLock: async (_target, fn) => fn(),
  };
}
