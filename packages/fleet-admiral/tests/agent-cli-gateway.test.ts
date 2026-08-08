import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findGatewayModel } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

import {
  FLEET_PLUGIN_NAME,
  GATEWAY_DISABLED_CLAUDE_SKILLS,
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
      effort: "xhigh",
    });

    expect(profile).toMatchObject({
      args: ["--model", "claude-gateway--cursor-auto", "--effort", "xhigh"],
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
      expect(agent.description).toContain(`agent type name ${FLEET_PLUGIN_NAME}:${name}`);
    }
    const withEffort = names.find((name) => name.endsWith("-high"));
    expect(withEffort).toBeDefined();
    expect(agents[withEffort!]!.effort).toBe("high");
    expect(toGatewayAgentName(agents[withEffort!]!.model, "high")).toBe(withEffort);
  });

  it("builds identities only for the models the caller provides", () => {
    const included = requireGatewayModel("cursor--claude-opus-5");
    const omittedModelId = "claude-gateway--opencode--deepseek-v4-flash";

    const agents = buildGatewayCustomAgents([included]);
    expect(Object.keys(agents).length).toBeGreaterThan(0);
    expect(Object.values(agents).map((agent) => agent.model)).not.toContain(omittedModelId);

    const files = buildGatewayAgentFiles([included]);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => !file.content.includes(omittedModelId))).toBe(true);
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

  it("embeds CursorBench figures and a role-fit sentence in each identity description", () => {
    const solHigh = buildGatewayCustomAgents([requireGatewayModel("codex--gpt-5.6-sol-fast")])["codex-gpt-5-6-sol-fast-1m-high"];
    expect(solHigh?.description).toContain("Bench CursorBench 3.2: 63.5% at high effort, ~14k tokens/task.");
    expect(solHigh?.description).toContain("Class prior: judgment-seat candidate (decide, judge, synthesize) — the figures above, not the label, set its band.");

    const lunaHigh = buildGatewayCustomAgents([requireGatewayModel("codex--gpt-5.6-luna-fast")])["codex-gpt-5-6-luna-fast-1m-high"];
    expect(lunaHigh?.description).toContain("Class prior: light lineup — fits wide mechanical fans (recon, scan, extract, verify), though measured figures can still earn a band seat.");

    for (const definition of Object.values(buildGatewayCustomAgents([requireGatewayModel("cursor--grok-4.5")]))) {
      expect(definition.description).toContain("score carries a caveat");
    }

    // CursorBench 미측정 모델은 벤치 문장 없이 class 폴백 문장만 싣는다 —
    // 단일 소스 정책이 호스트 판정을 class prior 로 유도하는 지점.
    for (const modelId of ["minimax-m3", "deepseek-v4-pro", "qwen3.8-max", "deepseek-v4-flash", "hy3", "mimo-v2.5"]) {
      const definitions = Object.values(buildGatewayCustomAgents([requireGatewayModel(`opencode--${modelId}`)]));
      expect(definitions.length).toBeGreaterThan(0);
      for (const definition of definitions) {
        expect(definition.description, modelId).toContain("No bench evidence; capability class is the only prior.");
        expect(definition.description, modelId).not.toContain("Bench SWE-rebench");
        expect(definition.description, modelId).not.toContain("Bench AA Terminal-Bench");
      }
    }
  });

  it("registers gateway identities as plugin agent files, and never disables a built-in agent", async () => {
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
      gatewayDelegationModels: [model],
    }));
    const injectedNative = await injectAgentCliProfile(native, baseInjectOptions(root, {
      gatewayDelegationModels: [model],
    }));

    // 게이트웨이 정의는 내장 Agent를 대체하지 않고 그 옆에 놓인다. 내장을 끄면
    // 상속(unpinned) 위임이 막혀 세션 자신의 모델로 도는 작업을 만들 수 없다.
    expect(injectedGateway.args).not.toContain("--disallowedTools");

    // 정의가 argv에 실리면 Windows 명령줄 한도가 로스터 크기를 대신 정한다 — 정의 하나가
    // 1.9KB쯤이라 스무 개만 노출해도 프롬프트를 싣기 전에 실행이 불가능해진다.
    expect(injectedGateway.args).not.toContain("--agents");
    expect(injectedNative.args).not.toContain("--agents");
    expect(injectedNative.args).not.toContain("--disallowedTools");

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
    // native 세션은 게이트웨이 정체성을 하나도 얻지 않는다.
    expect(readdirSync(agentsDirOf(injectedNative))).toEqual([]);

    injectedGateway.cleanup?.();
    injectedNative.cleanup?.();
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
    ...(overrides.gatewayDelegationModels ? { gatewayDelegationModels: overrides.gatewayDelegationModels } : {}),
    withMarketplaceLock: async (_target, fn) => fn(),
  };
}
