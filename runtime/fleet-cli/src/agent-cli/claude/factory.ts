import { resolveAuthEnv } from "@dotobokuri/fleet-infra/auth";

import { createChildEnv, resolveBinary } from "../resolve-bin.js";
import type { AgentCliDefinition, AgentCliId, AgentCliProfileOptions } from "../types.js";
import { createClaudeEnv } from "./env.js";

interface ClaudeFamilyCliFactoryOptions {
  readonly id: Extract<AgentCliId, "claude" | "claude-zai" | "claude-kimi">;
  readonly label: string;
  readonly authCli?: Extract<AgentCliId, "claude-zai" | "claude-kimi">;
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
      const authEnv = options.authCli ? await resolveAuthEnv(options.authCli) : {};
      return {
        args: [...prefixArgs, ...buildModelArgs(profileOptions.model)],
        bin,
        cwd: profileOptions.cwd,
        env: createChildEnv(profileOptions.env, {
          ...createClaudeEnv(),
          ...authEnv,
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
