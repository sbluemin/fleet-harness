import { createChildEnv, resolveBinary } from "@dotobokuri/core-process";

import { assertLaunchPromptShimSafe, resolveLaunchCommandLineLimit, sanitizeLaunchPrompt } from "../prompt.js";
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
      // prefixArgs가 있으면 이 실행은 cmd.exe를 거친다 — 그 명령줄에 임의 텍스트를 실을 수 없다.
      assertLaunchPromptShimSafe(launchPrompt, prefixArgs);
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

// ultracode는 wire effort가 아니라 하네스 능력(standing multi-agent orchestration)이다.
// Claude Code CLI 2.1.226의 --effort는 max에서 닫히고 알 수 없는 값은 경고 후 기본값으로
// 떨어지므로(2026-08-11 와이어 실측: --effort/--settings 모두 ultra→xhigh 클램프),
// wire effort는 유효 최고 단인 max로 고정하고 능력은 settings 병합 채널로 켠다.
function buildEffortArgs(effort: string | undefined): string[] {
  if (effort === undefined) return [];
  if (effort === "ultra") return ["--effort", "max", "--settings", "{\"ultracode\":true}"];
  return ["--effort", effort];
}
