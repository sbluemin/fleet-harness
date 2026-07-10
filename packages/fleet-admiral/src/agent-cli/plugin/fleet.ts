import path from "node:path";

import { EMBEDDED_AGENT_CLI_SKILL_ASSETS } from "../assets.generated.js";
import { buildHostShellCommand } from "../builders/toml.js";
import { renderCursorDoctrineHookAssets } from "../doctrine-hook.js";
import { writePrivateFile, writePrivateJson } from "./fs.js";
import type { AgentCliMcpServerArg } from "../types.js";
import type { FleetHookExec } from "../types.js";
import type { AssetPluginBundle, CreateAgentCliPluginOptions } from "./types.js";

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
  const doctrineHookExec = options.cliId === "cursor" && options.doctrine !== undefined
    ? renderCursorDoctrineHookAssets(pluginRoot, options.doctrine)
    : undefined;
  if (options.cliId === "claude") {
    writePrivateJson(path.join(pluginRoot, "hooks", "hooks.json"), claudeHooks(options), pluginRoot);
  }
  if (options.cliId === "cursor") {
    renderCursorPluginRoot(pluginRoot, options, doctrineHookExec);
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

function renderCursorPluginRoot(
  pluginRoot: string,
  options: CreateAgentCliPluginOptions,
  doctrineHookExec: FleetHookExec | undefined,
): void {
  if ((options.mcpServers ?? []).length > 0) {
    writePrivateJson(path.join(pluginRoot, "mcp.json"), cursorMcpConfig(options.mcpServers ?? []), pluginRoot);
  }
  const hooks = cursorHooks(options, doctrineHookExec);
  if (hooks !== undefined) {
    writePrivateJson(path.join(pluginRoot, "hooks", "hooks.json"), hooks, pluginRoot);
  }
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

function cursorHooks(
  options: CreateAgentCliPluginOptions,
  doctrineHookExec: FleetHookExec | undefined,
): unknown | undefined {
  const sessionStartExecs = [doctrineHookExec, options.captureSessionHookExec]
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
