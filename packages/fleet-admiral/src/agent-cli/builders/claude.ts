import type { AgentCliInjectionContext, AgentCliMcpServerArg } from "../types.js";

export function buildClaudeGatewayArgs(context: AgentCliInjectionContext): string[] {
  return [
    ...buildSessionArgs(context.sessionCoordinate),
    ...buildBaseSystemPromptArgs(context.claudeCodeSystemPrompt),
    ...context.pluginRoots.flatMap((pluginRoot) => [
      "--plugin-dir",
      pluginRoot,
    ]),
    ...(context.mcpServers.length > 0 ? ["--mcp-config", buildClaudeMcpConfig(context.mcpServers)] : []),
    ...buildSettingsArgs(context.skillOverrides),
    ...buildSearchToolArgs(),
    ...buildPermissionArgs(context.claudeCodeSkipPermissions),
  ];
}

/**
 * 두 방향 모두 명시한다. 끄는 쪽에서 플래그를 빼는 것만으로는 게이트가 서지 않기 때문이다 —
 * 그때는 사용자·프로젝트 설정의 `permissions.defaultMode`가 그대로 살아난다.
 *
 * 실측(Claude Code 2.1.251, 격리 config): 사용자 설정에 `permissions.defaultMode:
 * "bypassPermissions"`만 두고 플래그 없이 열면 init 메시지가 `permissionMode:
 * "bypassPermissions"`로 온다. 같은 설정에 `--permission-mode default`를 더하면 `"default"`가
 * 온다. 즉 플래그를 빼는 선택은 "게이트를 세운다"가 아니라 "주변 설정에 맡긴다"이고, 그러면
 * 설정 화면은 끔이라고 말하면서 세션은 바이패스로 도는 조합이 생긴다.
 *
 * 이 자리는 Fleet이 자기 런치의 권한 모드를 정하는 곳이다. 바이패스를 강제하던 이전에도
 * 주변 설정은 이미 무시되고 있었으므로, 반대 방향을 못박는 것은 좁히기가 아니라 같은 권한을
 * 안전한 쪽으로 돌리는 것이다. 무엇을 승인할지 묻고 답을 받는 화면은 Claude Code TUI의 것이고,
 * Fleet은 그것을 대신 그리지 않는다.
 */
function buildPermissionArgs(claudeCodeSkipPermissions: boolean | undefined): string[] {
  return claudeCodeSkipPermissions === true
    ? ["--dangerously-skip-permissions"]
    : ["--permission-mode", "default"];
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
 * 바이패스 런치에서 이 목록은 권한 판정에 관여하지 않으므로 순수 가산이다. 승인 게이트가
 * 살아 있는 런치에서는 허용 목록으로도 읽혀 이 두 이름만 무승인으로 지나간다 — 둘 다 읽기
 * 전용이라 의도한 결과지만, "가산일 뿐"이라는 말이 한쪽 런치에서만 참이라는 것은 적어 둔다.
 */
function buildSearchToolArgs(): string[] {
  return ["--allowedTools", "Grep,Glob"];
}

/**
 * `--settings`는 인라인 JSON을 받아 flag 소스로 병합한다. 사용자·프로젝트 설정을
 * 대체하지 않으므로 여기서는 Fleet이 강제하는 키만 싣는다.
 */
function buildSettingsArgs(
  skillOverrides: AgentCliInjectionContext["skillOverrides"],
): string[] {
  if (skillOverrides === undefined || Object.keys(skillOverrides).length === 0) return [];
  return ["--settings", JSON.stringify({ skillOverrides })];
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
 * Claude Code 기본 시스템 프롬프트를 끌 때만 플래그가 실린다. Fleet은 실을 본문이 없으므로
 * 값은 빈 문자열이다 — 대체할 텍스트가 아니라 비우는 수단이다. 파일로 쓰던 옛 경로는 Fleet
 * 프롬프트가 길어서 필요했던 것이고, 여기에는 옮길 본문 자체가 없다.
 */
function buildBaseSystemPromptArgs(claudeCodeSystemPrompt: "on" | "off" | undefined): string[] {
  return claudeCodeSystemPrompt === "off" ? ["--system-prompt", ""] : [];
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
