import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findGatewayModel } from "@fleet-console/ai-gateway";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FLEET_PLUGIN_NAME } from "@fleet-console/ai-gateway";
import { GATEWAY_DISABLED_CLAUDE_SKILLS, getAgentCliIds, getAgentCliMetadata, parseAgentCliId, buildDisabledSkillOverrides, injectAgentCliProfile, prepareClaudeSession, resolveAgentCliProfile, type AgentCliProfile, type FleetHookExec } from "@fleet-console/agent-runtime/fleet";
import { buildClaudeGatewayArgs } from "../../foundation/agent-runtime/src/fleet/agent-cli/builders/claude.js";
import type { AgentCliInjectionContext } from "../../foundation/agent-runtime/src/fleet/agent-cli/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

const pluginStub = { url: async () => "http://127.0.0.1:9/fleet-plugin-stub/fleet.zip", close: async () => {} };

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

  it("merges opted-out subagents and disabled tools into one deny list on both surfaces", async () => {
    const root = createTempRoot("fleet-admiral-gateway-agent-optout-");
    const profile = baseProfile("claude", { args: [], cwd: root, env: { HOME: root } });
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      claudeCodeDisabledAgents: ["Explore", "Plan", "Explore"],
      claudeCodeDisabledTools: ["AskUserQuestion"],
    }));

    try {
      // argv: `--settings`의 permissions.deny — 스킬 억제와 같은 JSON에 함께 실린다.
      const settings = JSON.parse(injected.args[injected.args.indexOf("--settings") + 1] ?? "{}") as {
        readonly permissions?: { readonly deny?: readonly string[] };
        readonly skillOverrides?: Record<string, string>;
      };
      expect(settings.permissions?.deny).toEqual(["Agent(Explore)", "Agent(Plan)", "AskUserQuestion"]);
      expect(settings.skillOverrides).toBeDefined();
    } finally {
      injected.cleanup?.();
    }

    // SDK: 같은 규칙이 disallowedTools로 나온다 — 한 세션의 두 얼굴이 같은 정책을 받는다.
    const session = await prepareClaudeSession({
      cliId: "claude",
      cwd: root,
      plugin: pluginStub,
      origin: { kind: "new" },
      claudeCodeDisabledAgents: ["*"],
      claudeCodeDisabledTools: ["AskUserQuestion"],
    });
    // 도구를 끄는 정책이 서브에이전트 차단을 덮지 않는다.
    expect(session.sdk.request.disallowedTools).toEqual(["Agent", "Task", "AskUserQuestion"]);

    // 옵트아웃이 없으면 규칙 키 자체가 실리지 않는다.
    const untouched = await prepareClaudeSession({ cliId: "claude", cwd: root, plugin: pluginStub, origin: { kind: "new" } });
    expect(untouched.sdk.request).not.toHaveProperty("disallowedTools");
  });

  /**
   * 한 스위치가 두 표면에서 같은 세션을 만드는지 본다.
   *
   * 두 표면의 표현이 서로 뒤집혀 있어 사상이 갈리기 쉽다: CLI는 기본 프롬프트를 쓸 때 아무
   * 플래그도 싣지 않고, SDK는 그때 `preset`을 실어야 한다(생략은 최소 프롬프트다). 실제로
   * 한 번 갈려서, Chat은 사용자가 기본 프롬프트를 껐을 때 빈 `replace`를 보내 vendor가
   * 턴마다 `TypeError`로 거절했고 화면에는 원인 없는 실패만 남았다.
   */
  it("maps one system prompt setting onto argv and the SDK projection alike", async () => {
    const root = createTempRoot("fleet-admiral-gateway-system-prompt-");
    const profile = baseProfile("claude", { args: [], cwd: root, env: { HOME: root } });
    const body = "한국어로 답합니다.";

    // 기본 프롬프트만: argv는 아무 플래그도 싣지 않고, SDK는 preset을 명시한다.
    const preset = await injectAgentCliProfile(profile, baseInjectOptions(root, { claudeCodeSystemPrompt: "on" }));
    try {
      expect(preset.args).not.toContain("--system-prompt");
      expect(preset.args).not.toContain("--append-system-prompt-file");
      expect(preset.session.sdk.request.systemPrompt).toEqual({ mode: "preset" });
    } finally {
      preset.cleanup?.();
    }

    // 기본 + 사용자 지침: 본문은 argv가 아니라 파일로 가고, SDK는 같은 본문을 append한다.
    const appended = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      claudeCodeSystemPrompt: "append",
      claudeCodeCustomSystemPrompt: body,
    }));
    try {
      const filePath = appended.args[appended.args.indexOf("--append-system-prompt-file") + 1];
      expect(filePath).toBeDefined();
      expect(readFileSync(filePath!, "utf8")).toBe(body);
      expect(appended.args).not.toContain(body);
      expect(appended.session.sdk.request.systemPrompt).toEqual({ mode: "append", text: body });
    } finally {
      appended.cleanup?.();
    }

    // 사용자 지침만: 교체 플래그도 파일로 가고, SDK는 replace가 된다.
    const replaced = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      claudeCodeSystemPrompt: "off",
      claudeCodeCustomSystemPrompt: body,
    }));
    try {
      const filePath = replaced.args[replaced.args.indexOf("--system-prompt-file") + 1];
      expect(filePath).toBeDefined();
      expect(readFileSync(filePath!, "utf8")).toBe(body);
      // 빈 문자열은 falsy라 이 CLI의 교체 플래그 상호배타 검사를 통과한다. 둘이 같은
      // 런치에 실리면 어느 쪽이 이기는지가 조용히 뒤집힌다.
      expect(replaced.args).not.toContain("--system-prompt");
      expect(replaced.session.sdk.request.systemPrompt).toEqual({ mode: "replace", text: body });
    } finally {
      replaced.cleanup?.();
    }

    // 지침 없이 끈 경우만 빈 본문으로 남는다. SDK에서는 빈 본문을 실을 수 없어 생략이 그 자리다.
    const cleared = await injectAgentCliProfile(profile, baseInjectOptions(root, { claudeCodeSystemPrompt: "off" }));
    try {
      expect(cleared.args[cleared.args.indexOf("--system-prompt") + 1]).toBe("");
      expect(cleared.session.sdk.request).not.toHaveProperty("systemPrompt");
    } finally {
      cleared.cleanup?.();
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
    readonly captureSessionHookExec?: FleetHookExec;
    readonly claudeCodeSystemPrompt?: "on" | "append" | "off";
    readonly claudeCodeCustomSystemPrompt?: string;
    readonly claudeCodeSkipPermissions?: boolean;
    readonly claudeCodeDisabledAgents?: readonly string[];
    readonly claudeCodeDisabledTools?: readonly string[];
  } = {},
): Parameters<typeof injectAgentCliProfile>[1] {
  return {
    plugin: pluginStub,
    ...(overrides.claudeCodeSystemPrompt ? { claudeCodeSystemPrompt: overrides.claudeCodeSystemPrompt } : {}),
    ...(overrides.claudeCodeCustomSystemPrompt
      ? { claudeCodeCustomSystemPrompt: overrides.claudeCodeCustomSystemPrompt }
      : {}),
    ...(overrides.claudeCodeSkipPermissions !== undefined
      ? { claudeCodeSkipPermissions: overrides.claudeCodeSkipPermissions }
      : {}),
    ...(overrides.claudeCodeDisabledAgents ? { claudeCodeDisabledAgents: overrides.claudeCodeDisabledAgents } : {}),
    ...(overrides.claudeCodeDisabledTools ? { claudeCodeDisabledTools: overrides.claudeCodeDisabledTools } : {}),
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
  };
}
