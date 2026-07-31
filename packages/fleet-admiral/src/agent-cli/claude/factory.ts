import { createChildEnv, resolveBinary } from "@dotobokuri/core-agent";

import { resolveAgentCliAuthEnv } from "../auth.js";
import { resolveKimiModelSelection, resolveKimiModelSelectionFromOverride } from "../kimi-model.js";
import type { AgentCliDefinition, AgentCliId, AgentCliProfileOptions } from "../types.js";

interface ClaudeFamilyCliFactoryOptions {
  readonly id: Extract<AgentCliId, "claude" | "claude-kimi" | "claude-gateway">;
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
      const authEnv = options.id === "claude-gateway"
        // 게이트웨이는 upstream 자격증명을 자식에게 넘기지 않는다. 세션 bearer와 base URL은
        // Console 포트를 아는 host가 launch 시점에 주입한다.
        ? {}
        : await resolveAgentCliAuthEnv(
          options.id,
          profileOptions.authService,
          options.id === "claude-kimi"
            ? (profileOptions.model
              // 명시적 모델이 레지스트리에 없는 자유 형식이면 env는 레지스트리 기본값으로 두고
              // --model 인자만 전달해 종전 동작을 보존한다(getModelContextWindow throw 방지).
              ? resolveKimiModelSelectionFromOverride(profileOptions.model)
              : resolveKimiModelSelection(profileOptions.globalOptionsService))
            : undefined,
        );
      const childEnv = createChildEnv(profileOptions.env, authEnv);
      if (options.id === "claude-kimi") {
        // Never forward an inherited Anthropic bearer token to Moonshot's endpoint.
        delete childEnv.ANTHROPIC_AUTH_TOKEN;
      }
      if (options.id === "claude-gateway") {
        // 게이트웨이 인증은 host가 주입하는 ANTHROPIC_AUTH_TOKEN 하나뿐이다. 상속된 API key가
        // 남아 있으면 Claude Code가 x-api-key로 함께 보내 인증 축이 갈라진다.
        delete childEnv.ANTHROPIC_API_KEY;
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
