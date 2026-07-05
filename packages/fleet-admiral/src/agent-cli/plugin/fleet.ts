import path from "node:path";

import { EMBEDDED_AGENT_CLI_SKILL_ASSETS } from "../assets.generated.js";
import { buildHostShellCommand } from "../builders/toml.js";
import { writePrivateFile, writePrivateJson } from "./fs.js";
import type { AgentCliMcpServerArg } from "../types.js";
import type { FleetHookExec } from "../types.js";
import type { AssetPluginBundle, CreateAgentCliPluginOptions } from "./types.js";

const CURSOR_DOCTRINE_RULE_FILE = "fleet-doctrine.mdc";
const CURSOR_DOCTRINE_RULE_FRONTMATTER = `---
description: Fleet Admiral operating doctrine. Always apply in Fleet-launched Cursor Agent sessions.
globs:
alwaysApply: true
---
`;
const CURSOR_DOCTRINE_RULE_PREAMBLE = `# Fleet Runtime Doctrine for Cursor Agent

You are running as Cursor Agent inside Fleet. Cursor provides this file as a persistent rule, not as a native system prompt. For this Fleet-launched session, treat the embedded Fleet system prompt below as your active Fleet runtime doctrine.

Priority and interpretation:

- Follow higher-priority platform, system, developer, and direct user instructions first.
- Within Cursor rules, project instructions, and other same-layer guidance, this Fleet doctrine is the governing instruction set for Fleet identity, roles, workflow, carrier operations, and reporting.
- Treat Fleet identity and role names from the embedded prompt as the identity anchor for this session. Do not replace them with generic Cursor Agent identity when answering, planning, or delegating.
- Do not treat this document as optional background or reference material. Apply it continuously when deciding who you are, how Fleet roles are named, which protocol applies, and how to report work.
- Do not merely summarize or acknowledge the embedded prompt. Execute the operational requirements it defines, including protocol selection, evidence thresholds, carrier routing, and result reporting.
- If other same-layer Cursor rules conflict with this doctrine, preserve the Fleet doctrine unless the user's latest explicit instruction requires a narrower task-specific exception.
- When unsure whether a Fleet instruction applies, prefer following the Fleet doctrine and briefly surface the uncertainty instead of silently ignoring it.

## Embedded Fleet System Prompt

The following block is the Fleet system prompt content adapted for Cursor's rules mechanism. It is intentionally embedded verbatim after this wrapper.

<fleet-system-prompt>
`;
const CURSOR_DOCTRINE_RULE_FOOTER = `
</fleet-system-prompt>
`;

export const assetBundle: AssetPluginBundle = {
  description: "Fleet carrier delegation and wiki evidence plugin",
  directoryName: "fleet",
  displayName: "Fleet",
  hashFileName: ".fleet-codex-plugin.hash",
  name: "fleet",
  source: "asset",
};

export function renderAssetPluginRoot(
  pluginRoot: string,
  bundle: AssetPluginBundle,
  options: CreateAgentCliPluginOptions,
): void {
  renderEmbeddedSkillAssets(pluginRoot);
  if (options.cliId === "claude") {
    writePrivateJson(path.join(pluginRoot, "hooks", "hooks.json"), claudeHooks(options), pluginRoot);
  }
  if (options.cliId === "cursor") {
    renderCursorPluginRoot(pluginRoot, options);
  }
}

function claudeHooks(options: CreateAgentCliPluginOptions): unknown {
  // UserPromptSubmit: 세션 캡처 + 턴 시작 + 자동 작명 신호를 같은 이벤트에 함께 건다(배열 순서대로 실행).
  const userPromptSubmitExecs = [options.captureSessionHookExec, options.turnStartHookExec, options.autoNameHookExec]
    .filter((exec): exec is FleetHookExec => exec !== undefined);
  // Stop: 턴 종료 신호.
  const stopExecs = [options.turnEndHookExec]
    .filter((exec): exec is FleetHookExec => exec !== undefined);
  // 입력 대기 신호: AskUserQuestion은 tool call이라 PreToolUse(matcher=AskUserQuestion)로 확실히 잡고,
  // 그 외 입력 대기는 Notification의 입력 대기 타입만 |-구분 정확 매처로 거른다
  // (idle_prompt(정상 유휴 대기, 차단 아님)·auth_success·elicitation_complete/response 등 비대기 타입 제외).
  // 한 번의 대기가 PreToolUse와 Notification 두 경로로 동시에 들어올 수 있어, 최종 중복 제거는 클라이언트(store)에서 세션별로 한다.
  const inputWaitingExec = options.inputWaitingHookExec;
  return {
    hooks: {
      ...(userPromptSubmitExecs.length > 0 ? {
        UserPromptSubmit: [{
          hooks: userPromptSubmitExecs.map(claudeCommandHook),
        }],
      } : {}),
      ...(stopExecs.length > 0 ? {
        Stop: [{
          hooks: stopExecs.map(claudeCommandHook),
        }],
      } : {}),
      ...(inputWaitingExec ? {
        PreToolUse: [{
          matcher: "AskUserQuestion",
          hooks: [claudeCommandHook(inputWaitingExec)],
        }],
        Notification: [{
          matcher: "permission_prompt|elicitation_dialog",
          hooks: [claudeCommandHook(inputWaitingExec)],
        }],
      } : {}),
    },
  };
}

function claudeCommandHook(hookExec: FleetHookExec): unknown {
  return {
    // exec 형식: command는 직접 spawn되는 실행 파일, args는 셸 토크나이징 없이 그대로 전달된다.
    // Windows cmd/powershell의 따옴표 규칙과 무관하게 동작하며 공백 포함 경로도 안전하다.
    args: [...hookExec.args],
    command: hookExec.command,
    type: "command",
  };
}

function renderCursorPluginRoot(pluginRoot: string, options: CreateAgentCliPluginOptions): void {
  if (options.doctrine !== undefined) {
    renderCursorDoctrineRule(pluginRoot, options.doctrine);
  }
  if ((options.mcpServers ?? []).length > 0) {
    writePrivateJson(path.join(pluginRoot, "mcp.json"), cursorMcpConfig(options.mcpServers ?? []), pluginRoot);
  }
  const hooks = cursorHooks(options);
  if (hooks !== undefined) {
    writePrivateJson(path.join(pluginRoot, "hooks", "hooks.json"), hooks, pluginRoot);
  }
}

function renderCursorDoctrineRule(pluginRoot: string, doctrine: string): void {
  writePrivateFile(
    path.join(pluginRoot, "rules", CURSOR_DOCTRINE_RULE_FILE),
    `${CURSOR_DOCTRINE_RULE_FRONTMATTER}${CURSOR_DOCTRINE_RULE_PREAMBLE}${doctrine}${CURSOR_DOCTRINE_RULE_FOOTER}`,
    pluginRoot,
  );
}

function cursorMcpConfig(servers: readonly AgentCliMcpServerArg[]): unknown {
  return {
    mcpServers: Object.fromEntries(
      servers.map((server) => [server.name, {
        type: "http",
        url: server.endpointUrl,
        headers: {
          Authorization: `Bearer ${server.bearerToken}`,
        },
      }]),
    ),
  };
}

function cursorHooks(options: CreateAgentCliPluginOptions): unknown | undefined {
  const sessionStartExecs = [options.captureSessionHookExec]
    .filter((exec): exec is FleetHookExec => exec !== undefined);
  const beforeSubmitPromptExecs = [options.turnStartHookExec, options.autoNameHookExec]
    .filter((exec): exec is FleetHookExec => exec !== undefined);
  const stopExecs = [options.turnEndHookExec]
    .filter((exec): exec is FleetHookExec => exec !== undefined);
  if (sessionStartExecs.length === 0 && beforeSubmitPromptExecs.length === 0 && stopExecs.length === 0) return undefined;
  return {
    version: 1,
    hooks: {
      ...(sessionStartExecs.length > 0 ? {
        sessionStart: sessionStartExecs.map((exec) => cursorCommandHook(exec)),
      } : {}),
      ...(beforeSubmitPromptExecs.length > 0 ? { beforeSubmitPrompt: beforeSubmitPromptExecs.map((exec) => cursorCommandHook(exec)) } : {}),
      ...(stopExecs.length > 0 ? { stop: stopExecs.map((exec) => cursorCommandHook(exec)) } : {}),
    },
  };
}

function cursorCommandHook(hookExec: FleetHookExec, extraArgs: readonly string[] = []): unknown {
  return {
    type: "command",
    command: buildHostShellCommand([hookExec.command, ...hookExec.args, ...extraArgs]),
  };
}

function renderEmbeddedSkillAssets(pluginRoot: string): void {
  for (const asset of EMBEDDED_AGENT_CLI_SKILL_ASSETS) {
    writePrivateFile(path.join(pluginRoot, "skills", asset.relativePath), asset.content, pluginRoot);
  }
}
