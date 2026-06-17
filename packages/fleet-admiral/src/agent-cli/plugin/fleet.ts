import path from "node:path";

import { EMBEDDED_AGENT_CLI_SKILL_ASSETS } from "../assets.generated.js";
import { writePrivateFile, writePrivateJson } from "./fs.js";
import type { FleetHookExec } from "../types.js";
import type { AssetPluginBundle, CreateAgentCliPluginOptions } from "./types.js";

const CLAUDE_AGENT_FILE_STEM_ALLOWLIST = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export const assetBundle: AssetPluginBundle = {
  description: "Fleet carrier delegation and wiki evidence plugin",
  directoryName: "fleet",
  displayName: "Fleet",
  hashFileName: ".fleet-codex-plugin.hash",
  includeClaudeAgents: true,
  name: "fleet",
  source: "asset",
};

export function renderAssetPluginRoot(
  pluginRoot: string,
  bundle: AssetPluginBundle,
  options: CreateAgentCliPluginOptions,
): void {
  renderEmbeddedSkillAssets(pluginRoot);
  if (bundle.includeClaudeAgents) {
    for (const subagent of options.claudeDefinitions) {
      const fileStem = parseClaudeAgentFileStem(subagent.name);
      writePrivateFile(path.join(pluginRoot, "agents", `${fileStem}.md`), claudeAgentFile(subagent), pluginRoot);
    }
  }
  if (options.cliId === "claude" || options.cliId === "claude-kimi") {
    writePrivateJson(path.join(pluginRoot, "hooks", "hooks.json"), claudeHooks(options), pluginRoot);
  }
}

export function validateClaudeAgentFileStems(
  subagents: CreateAgentCliPluginOptions["claudeDefinitions"],
): void {
  for (const subagent of subagents) {
    parseClaudeAgentFileStem(subagent.name);
  }
}

function parseClaudeAgentFileStem(name: string): string {
  if (CLAUDE_AGENT_FILE_STEM_ALLOWLIST.test(name) && path.basename(name) === name) return name;
  throw new Error(`Invalid Claude agent file name: ${name}`);
}

function claudeHooks(options: CreateAgentCliPluginOptions): unknown {
  const hookExec = options.hookExec;
  if (!hookExec) {
    throw new Error("Fleet Claude session hook command is required");
  }
  // UserPromptSubmit: 세션 캡처 + 턴 시작 신호를 같은 이벤트에 함께 건다(배열 순서대로 실행).
  const userPromptSubmitExecs = [options.captureSessionHookExec, options.turnStartHookExec]
    .filter((exec): exec is FleetHookExec => exec !== undefined);
  // Stop: 턴 종료 신호.
  const stopExecs = [options.turnEndHookExec]
    .filter((exec): exec is FleetHookExec => exec !== undefined);
  return {
    hooks: {
      SessionStart: [{
        hooks: [claudeCommandHook(hookExec)],
      }],
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
    },
  };
}

function claudeCommandHook(hookExec: CreateAgentCliPluginOptions["hookExec"]): unknown {
  if (!hookExec) {
    throw new Error("Fleet Claude session hook command is required");
  }
  return {
    // exec 형식: command는 직접 spawn되는 실행 파일, args는 셸 토크나이징 없이 그대로 전달된다.
    // Windows cmd/powershell의 따옴표 규칙과 무관하게 동작하며 공백 포함 경로도 안전하다.
    args: [...hookExec.args],
    command: hookExec.command,
    type: "command",
  };
}

function claudeAgentFile(subagent: CreateAgentCliPluginOptions["claudeDefinitions"][number]): string {
  const frontmatter = [
    "---",
    `name: ${yamlScalar(subagent.name)}`,
    `description: ${yamlScalar(subagent.description)}`,
    ...(subagent.model ? [`model: ${yamlScalar(subagent.model)}`] : []),
    ...(subagent.effort ? [`effort: ${yamlScalar(subagent.effort)}`] : []),
    ...(subagent.color ? [`color: ${yamlScalar(subagent.color)}`] : []),
    "background: true",
    "---",
    "",
  ];
  return [...frontmatter, subagent.prompt, ""].join("\n");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function renderEmbeddedSkillAssets(pluginRoot: string): void {
  for (const asset of EMBEDDED_AGENT_CLI_SKILL_ASSETS) {
    writePrivateFile(path.join(pluginRoot, "skills", asset.relativePath), asset.content, pluginRoot);
  }
}
