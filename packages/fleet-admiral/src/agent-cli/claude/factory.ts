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
      // 원문은 여기서 거절하지 않는다. Windows에서 cmd가 재해석할 문자이거나 명령줄
      // 상한을 넘길 때만 주입 계층이 파일 포인터로 바꾸고, cmd shim이면 그 짧은 지시만
      // shim 안전 검사를 받는다.
      const commandLineLimit = resolveLaunchCommandLineLimit(prefixArgs);
      const childEnv = createChildEnv(profileOptions.env, {
        // 위임은 한 단으로 끝난다. 이 상한이 1이면 세션 자신(depth 0)만 Agent를 부를 수 있고,
        // 그 아래 서브에이전트에게는 Agent 도구가 아예 실리지 않는다 — 호출 후 거절이 아니라
        // 목록에서 사라진다. Fleet의 실행 에이전트 프롬프트가 산문으로 걸어 둔 "assignment
        // 전체를 재위임하지 말라"를 기계적으로 만드는 유일한 레버다.
        //
        // 에이전트 frontmatter로는 못 한다: `tools:` 허용목록은 MCP·지연 도구까지 함께 얼려
        // 게이트웨이 정체성에서 Fleet MCP를 떨어뜨리고, `disallowed-tools`는 스킬/명령 전용이라
        // 에이전트 파일에서는 조용히 무시되며, `tools: ["*", "Agent(...)"]`의 allowedAgentTypes는
        // 중첩 스폰을 실제로 막지 않는다(세 경로 모두 실측).
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH:
          profileOptions.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH ?? "1",
      });
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
