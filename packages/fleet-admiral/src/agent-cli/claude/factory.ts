import { createChildEnv, resolveBinary } from "@dotobokuri/core-agent";

import { clampGoalCheckLimit } from "../goal.js";
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
      // 한도를 건네지 않은 호스트의 환경은 건드리지 않는다. 덮어쓰면 운영자가 직접 설정한
      // CLAUDE_CODE_STOP_HOOK_BLOCK_CAP이 Console 기능 때문에 조용히 8로 바뀐다 —
      // Fleet CLI와 Console은 서로의 목표 동작을 바꾸지 않는 동격 호스트다.
      const childEnv = createChildEnv(
        profileOptions.env,
        profileOptions.goalCheckLimit === undefined
          ? {}
          : { CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: String(clampGoalCheckLimit(profileOptions.goalCheckLimit)) },
      );
      if (options.id === "claude-gateway") {
        // Provider credentials stay in the Console gateway. The Console host
        // supplies only the local gateway URL at launch time.
        delete childEnv.ANTHROPIC_API_KEY;
        delete childEnv.ANTHROPIC_AUTH_TOKEN;
      }
      return {
        args: [...prefixArgs, ...buildModelArgs(profileOptions.model), ...buildEffortArgs(profileOptions.effort)],
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
        // Claude Code 계열은 목표(정지 조건) 슬래시 명령 `/goal`을 지원한다.
        goalCommand: "/goal",
        terminalName: "xterm-256color",
      };
    },
  };
}

function buildModelArgs(model: string | undefined): string[] {
  return model === undefined ? [] : ["--model", model];
}

function buildEffortArgs(effort: string | undefined): string[] {
  return effort === undefined ? [] : ["--effort", effort];
}
