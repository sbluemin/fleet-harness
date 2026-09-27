import { buildClaudeDenyRules } from "../claude-agent-rules.js";
import type { AgentCliInjectionContext, AgentCliMcpServerArg } from "../types.js";

export function buildClaudeGatewayArgs(context: AgentCliInjectionContext): string[] {
  return [
    ...buildSessionArgs(context.sessionCoordinate),
    ...buildSystemPromptArgs(context.claudeCodeSystemPrompt, context.claudeCodeCustomSystemPromptFile),
    "--plugin-url",
    context.pluginUrl,
    ...(context.mcpServers.length > 0 ? ["--mcp-config", buildClaudeMcpConfig(context.mcpServers)] : []),
    ...buildSettingsArgs(context.skillOverrides, context.claudeCodeDisabledAgents, context.claudeCodeDisabledTools, context.workspaceHookExec),
    ...buildSearchToolArgs(),
    ...buildPermissionArgs(),
  ];
}

/**
 * Fleet 런치는 항상 승인 게이트를 건너뛴다 — Console·`fleet` 두 표면 모두 같은 bypass로 뜨고,
 * 사용자가 고르는 설정은 없다. 플래그를 빼면 사용자·프로젝트 설정의 `permissions.defaultMode`가
 * 되살아나 표면마다 다른 정책으로 돌 수 있으므로 명시한다. deny 규칙은 이 모드에서도 살아 있다.
 */
function buildPermissionArgs(): string[] {
  return ["--dangerously-skip-permissions"];
}

/**
 * Claude Code의 네이티브 빌드는 `Glob`/`Grep`을 걷어내고 임베드된 `bfs`/`ugrep`을
 * Bash 뒤로 숨긴다. 그래서 패널은 검색을 셸로만 할 수 있고, 게이트웨이 공급자에게는
 * 그 이름들이 아예 광고되지 않는다.
 *
 * `--tools`는 내장 집합을 통째로 **대체**하므로 두 도구를 되살리는 값이 나머지 열두
 * 개를 함께 지운다. 이름을 허용 목록에 올리는 쪽은 억제만 해제한다 — 측정: 무플래그
 * 12개, `--tools Grep,Glob` 2개, 이 플래그 14개.
 *
 * `--settings`의 `permissions.allow`로는 풀리지 않는다. 억제 해제는 이 플래그 전용이다.
 *
 * 바이패스 런치에서 이 목록은 권한 판정에 관여하지 않으므로 순수 가산이다.
 */
function buildSearchToolArgs(): string[] {
  return ["--allowedTools", "Grep,Glob"];
}

/**
 * `--settings`는 인라인 JSON을 받아 flag 소스로 병합한다. 사용자·프로젝트 설정을
 * 대체하지 않으므로 여기서는 Fleet이 강제하는 키만 싣는다.
 *
 * 내장 서브에이전트 옵트아웃은 `permissions.deny`의 `Agent(<name>)` 규칙이다. 실측(2.1.268):
 * 규칙에 걸린 이름은 Agent 도구의 선택지에서 빠지고, 그래도 부르면 자식이
 * `Agent type '<name>' has been denied by permission rule 'Agent(<name>)'`로 거절한다.
 * `--dangerously-skip-permissions` 런치에서도 deny 규칙은 살아 있다. `system/init`의
 * `agents` 목록은 이 규칙을 반영하지 않으므로 그 목록으로 적용 여부를 판정하지 말 것.
 */
function buildSettingsArgs(
  skillOverrides: AgentCliInjectionContext["skillOverrides"],
  disabledAgents: AgentCliInjectionContext["claudeCodeDisabledAgents"],
  disabledTools: AgentCliInjectionContext["claudeCodeDisabledTools"],
  workspaceHook: AgentCliInjectionContext["workspaceHookExec"],
): string[] {
  const settings: Record<string, unknown> = {};
  if (skillOverrides !== undefined && Object.keys(skillOverrides).length > 0) {
    settings.skillOverrides = skillOverrides;
  }
  const deny = buildClaudeDenyRules(disabledAgents, disabledTools);
  if (deny.length > 0) settings.permissions = { deny };
  if (workspaceHook) {
    // plugin CwdChanged는 2.1.212에서 누락된다. flag settings는 PTY와 SDK 양쪽에서 발화한다.
    const hook = { type: "command", command: workspaceHook.command, args: [...workspaceHook.args] };
    settings.hooks = {
      CwdChanged: [{ hooks: [hook] }],
      SessionStart: [{ hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
      PostToolUse: [{ matcher: "EnterWorktree|ExitWorktree", hooks: [hook] }],
    };
  }
  if (Object.keys(settings).length === 0) return [];
  return ["--settings", JSON.stringify(settings)];
}

/**
 * 세션 좌표를 자식 인자로 옮긴다.
 *
 * 새 세션과 갈래는 Fleet이 발급한 id를 `--session-id`로 못박는다 — 자식이 만든 id를 나중에
 * 훅으로 받아 적는 것과 달리, 이 값은 spawn 전에 이미 확정이다. 이어 붙이는 세션만 id를
 * 고를 수 없다(실측: `--session-id`는 `--fork-session`
 * 없이 `--resume`과 함께 쓰면 자식이 거부한다).
 */
function buildSessionArgs(coordinate: AgentCliInjectionContext["sessionCoordinate"]): string[] {
  switch (coordinate.kind) {
    // 호출자의 인자가 이미 좌표를 들고 있다. 여기서 `--session-id`를 더하면 자식이 거부한다.
    case "external":
      return [];
    case "resume":
      return ["--resume", coordinate.sessionId];
    case "fork":
      return ["--resume", coordinate.from, "--fork-session", "--session-id", coordinate.sessionId];
    default:
      return ["--session-id", coordinate.sessionId];
  }
}

/**
 * 사용자가 고른 시스템 프롬프트 구성을 CLI 플래그로 옮긴다. Fleet이 지어낸 글은 여기 없다 —
 * 실리는 본문은 전부 사용자가 쓴 것이고, 쓰지 않았으면 아무것도 붙지 않는다.
 *
 * 한때는 여기에 Fleet 라우팅 진입점을 덧붙였다. 호스트가 게이트웨이 모델을 고르게 만드는
 * 것이 그 글의 일이었는데, 지금은 Console이 실행마다 모델을 배정하므로 그 일이 없다.
 *
 * `off`에 본문이 없을 때만 남는 `--system-prompt ""`는 문서화된 계약이 아니라 이 CLI가
 * 빈 문자열을 교체 본문으로 받아 주는 성질에 기댄다. 빈 문자열은 falsy라 교체 플래그끼리의
 * 상호배타 검사를 통과하므로, 이 인자는 파일 플래그와 절대 같은 런치에 실리지 않는다 —
 * 아래 분기가 둘 중 하나만 내보내는 이유다.
 */
function buildSystemPromptArgs(
  claudeCodeSystemPrompt: "on" | "append" | "off" | undefined,
  customSystemPromptFile: string | undefined,
): string[] {
  if (claudeCodeSystemPrompt === "append") {
    return customSystemPromptFile === undefined ? [] : ["--append-system-prompt-file", customSystemPromptFile];
  }
  if (claudeCodeSystemPrompt === "off") {
    return customSystemPromptFile === undefined
      ? ["--system-prompt", ""]
      : ["--system-prompt-file", customSystemPromptFile];
  }
  return [];
}

function buildClaudeMcpConfig(servers: readonly AgentCliMcpServerArg[]): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(
      servers.map((server) => [server.name, {
        type: "http",
        url: server.endpointUrl,
        headers: {
          Authorization: `Bearer ${server.bearerToken}`,
        },
      }]),
    ),
  });
}
