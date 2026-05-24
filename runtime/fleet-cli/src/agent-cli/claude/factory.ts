import { resolveAuthEnv } from "@dotobokuri/fleet-infra/auth";

import { createChildEnv, resolveBinary } from "../resolve-bin.js";
import type { DedicatedCliDefinition, DedicatedCliId, DedicatedCliProfileOptions } from "../types.js";
import { createClaudeEnv } from "./env.js";

interface ClaudeFamilyCliFactoryOptions {
  readonly id: Extract<DedicatedCliId, "claude" | "claude-zai" | "claude-kimi">;
  readonly label: string;
  readonly authCli?: Extract<DedicatedCliId, "claude-zai" | "claude-kimi">;
}

export function createClaudeFamilyCliDefinition(
  options: ClaudeFamilyCliFactoryOptions,
): DedicatedCliDefinition {
  return {
    defaultBin: "claude",
    envOverrideName: "CLAUDE_BIN",
    id: options.id,
    label: options.label,
    async createProfile(profileOptions: DedicatedCliProfileOptions) {
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
