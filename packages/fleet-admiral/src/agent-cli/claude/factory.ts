import { createChildEnv, resolveBinary } from "@dotobokuri/core-agent";

import type { AgentCliDefinition, AgentCliId, AgentCliProfileOptions } from "../types.js";

interface ClaudeFamilyCliFactoryOptions {
  readonly id: Extract<AgentCliId, "claude-native" | "claude-gateway">;
  readonly label: string;
}

export function createClaudeFamilyCliDefinition(
  options: ClaudeFamilyCliFactoryOptions,
): AgentCliDefinition {
  return {
    id: options.id,
    label: options.label,
    async createProfile(profileOptions: AgentCliProfileOptions) {
      const { bin, prefixArgs } = resolveBinary("claude", "CLAUDE_BIN", profileOptions.env);
      const childEnv = createChildEnv(profileOptions.env, {});
      if (options.id === "claude-gateway") {
        // Provider credentials stay in the Console gateway. The Console host
        // supplies only the local gateway URL at launch time.
        delete childEnv.ANTHROPIC_API_KEY;
        delete childEnv.ANTHROPIC_AUTH_TOKEN;
      }
      return {
        args: [...prefixArgs, ...buildModelArgs(profileOptions.model)],
        bin,
        cwd: profileOptions.cwd,
        env: childEnv,
        id: options.id,
        label: options.label,
        messagePolicy: {
          bracketedPaste: true,
          lineTerminator: "\r",
          multilineStrategy: "paste-mode",
        },
        // Claude Code 계열은 세션 이름 변경 슬래시 명령 `/rename`을 지원한다.
        renameCommand: "/rename",
        terminalName: "xterm-256color",
      };
    },
  };
}

function buildModelArgs(model: string | undefined): string[] {
  return model === undefined ? [] : ["--model", model];
}
