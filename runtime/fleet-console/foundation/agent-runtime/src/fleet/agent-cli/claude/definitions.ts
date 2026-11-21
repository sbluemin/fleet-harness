import { createChildEnv, resolveBinary } from "@fleet-console/process";

import { resolveLaunchCommandLineLimit, sanitizeLaunchPrompt } from "../prompt.js";
import type { AgentCliDefinition, AgentCliId, AgentCliProfileOptions } from "../types.js";

// The installed Claude Code resolves Fable, Opus, Sonnet, and Haiku as native 1M.
// Console's execution id is one `<family>[1m]` coordinate per family. Bare aliases
// are accepted and folded; menu labels stay the plain family name.
const NATIVE_CANONICAL_ALIAS = {
  fable: "fable[1m]",
  "fable[1m]": "fable[1m]",
  opus: "opus[1m]",
  "opus[1m]": "opus[1m]",
  sonnet: "sonnet[1m]",
  "sonnet[1m]": "sonnet[1m]",
  haiku: "haiku[1m]",
  "haiku[1m]": "haiku[1m]",
} as const;

export const NATIVE_CLAUDE_MODEL_ALIASES = ["fable[1m]", "opus[1m]", "sonnet[1m]", "haiku[1m]"] as const;
export const ALL_NATIVE_CLAUDE_MODEL_ALIASES = [
  "fable[1m]",
  "opus[1m]",
  "sonnet[1m]",
  "haiku[1m]",
  "fable",
  "opus",
  "sonnet",
  "haiku",
] as const;
export const NATIVE_CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** bare·`[1m]` 입력을 실행 정준 id(`<family>[1m]`)로 접는다. 네 가족 밖이면 undefined. */
export function resolveNativeClaudeModelAlias(
  model: string,
): (typeof NATIVE_CLAUDE_MODEL_ALIASES)[number] | undefined {
  return NATIVE_CANONICAL_ALIAS[model as keyof typeof NATIVE_CANONICAL_ALIAS];
}


// 로컬 AI 게이트웨이로 향하는 Claude Code. 게이트웨이 URL과 세션 bearer는
// Console 포트를 아는 host가 launch 시점에 주입하므로 여기서는 정적 env를 두지 않는다.
export const claudeCli = createClaudeFamilyCliDefinition({
  id: "claude",
  label: "Claude",
});

interface ClaudeFamilyCliFactoryOptions {
  readonly id: AgentCliId;
  readonly label: string;
}

function createClaudeFamilyCliDefinition(
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
        args: [...prefixArgs, ...buildModelArgs(profileOptions.model), ...buildEffortArgs(profileOptions.effort), ...buildNameArgs(profileOptions.sessionName)],
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

// 세션 이름은 다른 세션이 이 세션을 부르는 주소다 — 줄바꿈·제어문자를 지우고 한 줄로만 싣는다.
function buildNameArgs(name: string | undefined): string[] {
  const clean = name?.replace(/[\r\n\t\u0000-\u001f]+/g, " ").trim().slice(0, 64);
  return clean ? ["-n", clean] : [];
}

function buildModelArgs(model: string | undefined): string[] {
  return model === undefined ? [] : ["--model", model];
}

function buildEffortArgs(effort: string | undefined): string[] {
  if (effort === undefined) return [];
  return ["--effort", effort];
}
