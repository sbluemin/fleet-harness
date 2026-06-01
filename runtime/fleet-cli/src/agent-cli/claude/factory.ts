import { createChildEnv, resolveBinary } from "../resolve-bin.js";
import type { AgentCliDefinition, AgentCliId, AgentCliProfileOptions } from "../types.js";
import { createClaudeEnv } from "./env.js";

interface ClaudeFamilyCliFactoryOptions {
  readonly id: Extract<AgentCliId, "claude">;
  readonly label: string;
}

export function createClaudeFamilyCliDefinition(
  options: ClaudeFamilyCliFactoryOptions,
): AgentCliDefinition {
  return {
    defaultBin: "claude",
    envOverrideName: "CLAUDE_BIN",
    id: options.id,
    label: options.label,
    async createProfile(profileOptions: AgentCliProfileOptions) {
      const { bin, prefixArgs } = resolveBinary("claude", "CLAUDE_BIN", profileOptions.env);
      return {
        args: [...prefixArgs, ...buildModelArgs(profileOptions.model)],
        bin,
        cwd: profileOptions.cwd,
        env: createChildEnv(profileOptions.env, {
          ...createClaudeEnv(),
        }),
        id: options.id,
        label: options.label,
        messagePolicy: {
          bracketedPaste: true,
          lineTerminator: "\r",
          multilineStrategy: "paste-mode",
        },
        terminalName: "xterm-256color",
      };
    },
  };
}

function buildModelArgs(model: string | undefined): string[] {
  return model === undefined ? [] : ["--model", model];
}
