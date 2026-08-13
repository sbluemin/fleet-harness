import { createChildEnv, resolveBinary } from "@dotobokuri/core-process";

import { resolveLaunchCommandLineLimit, sanitizeLaunchPrompt } from "../prompt.js";
import type { AgentCliDefinition, AgentCliId, AgentCliProfileOptions } from "../types.js";

interface ClaudeFamilyCliFactoryOptions {
  readonly id: AgentCliId;
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
      const launchPrompt = sanitizeLaunchPrompt(profileOptions.prompt);
      // 원문은 여기서 거절하지 않는다. 주입 계층이 파일 포인터로 바꾸고,
      // cmd shim이면 그 짧은 지시만 shim 안전 검사를 받는다.
      const commandLineLimit = resolveLaunchCommandLineLimit(prefixArgs);
      const childEnv = createChildEnv(profileOptions.env, {});
      return {
        args: [...prefixArgs, ...buildModelArgs(profileOptions.model), ...buildEffortArgs(profileOptions.effort)],
        bin,
        // prefixArgs는 이 프로필의 args로 접혀 들어간다 — shim 경유 여부를 아는 것은 이 지점이 마지막이다.
        ...(commandLineLimit === undefined ? {} : { commandLineLimit }),
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
        ...(launchPrompt === undefined ? {} : { promptArgs: [launchPrompt] }),
      };
    },
  };
}

function buildModelArgs(model: string | undefined): string[] {
  return model === undefined ? [] : ["--model", model];
}

// Console의 ultra 단은 Claude Code의 --effort ultracode다. CLI가 그 값으로 xhigh 강도와
// standing dynamic-workflow orchestration을 함께 켠다 — max로 바꾸거나 settings로
// ultracode를 우회 주입하지 않는다.
function buildEffortArgs(effort: string | undefined): string[] {
  if (effort === undefined) return [];
  if (effort === "ultra") return ["--effort", "ultracode"];
  return ["--effort", effort];
}
