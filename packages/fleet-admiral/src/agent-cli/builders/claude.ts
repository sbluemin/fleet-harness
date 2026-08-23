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
    "--dangerously-skip-permissions",
  ];
}

/**
 * Claude Code의 네이티브 빌드는 `Glob`/`Grep`을 걷어내고 임베드된 `bfs`/`ugrep`을
 * Bash 뒤로 숨긴다. 그래서 패널은 검색을 셸로만 할 수 있고, 게이트웨이 공급자에게는
 * 그 이름들이 아예 광고되지 않는다.
 *
 * `--tools`는 내장 집합을 통째로 **대체**하므로 두 도구를 되살리는 값이 나머지 열두
 * 개를 함께 지운다. 이름을 허용 목록에 올리는 쪽은 억제만 해제한다 — 측정: 무플래그
 * 12개, `--tools Grep,Glob` 2개, 이 플래그 14개. 바이패스 모드에서 허용 목록은 권한
 * 판정에 관여하지 않으니 여기서는 순수 가산이다.
 *
 * `--settings`의 `permissions.allow`로는 풀리지 않는다. 억제 해제는 이 플래그 전용이다.
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
