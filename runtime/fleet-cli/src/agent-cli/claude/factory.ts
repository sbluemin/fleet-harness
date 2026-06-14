import { createChildEnv, resolveBinary } from "@dotobokuri/core-agent";
import { resolveAuthEnv } from "@dotobokuri/fleet-infra/auth";

import type { AgentCliDefinition, AgentCliId, AgentCliProfileOptions } from "../types.js";

interface ClaudeFamilyCliFactoryOptions {
  readonly id: Extract<AgentCliId, "claude" | "claude-kimi">;
  readonly label: string;
  readonly authCli?: Extract<AgentCliId, "claude-kimi">;
}

export function createClaudeFamilyCliDefinition(
  options: ClaudeFamilyCliFactoryOptions,
): AgentCliDefinition {
  return {
    id: options.id,
    label: options.label,
    async createProfile(profileOptions: AgentCliProfileOptions) {
      const { bin, prefixArgs } = resolveBinary("claude", "CLAUDE_BIN", profileOptions.env);
      // Composition Root가 주입한 authService를 명시 전달한다 (per-call AuthService 암묵 생성 방지).
      const authEnv = options.authCli
        ? await resolveAuthEnv(options.authCli, { authService: profileOptions.authService })
        : {};
      return {
        args: [...prefixArgs, ...buildModelArgs(profileOptions.model)],
        bin,
        cwd: profileOptions.cwd,
        env: createChildEnv(profileOptions.env, authEnv),
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
