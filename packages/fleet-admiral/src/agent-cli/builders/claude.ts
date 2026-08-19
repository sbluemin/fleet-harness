import type { AgentCliInjectionContext, AgentCliMcpServerArg } from "../types.js";

export function buildClaudeGatewayArgs(context: AgentCliInjectionContext): string[] {
  return [
    ...buildResumeArgs(context.resumeSessionId),
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

function buildResumeArgs(resumeSessionId: string | undefined): string[] {
  return resumeSessionId === undefined ? [] : ["--resume", resumeSessionId];
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
