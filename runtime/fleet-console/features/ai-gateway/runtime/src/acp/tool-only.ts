import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AcpToolOnlyConfig } from "./contract.js";

/**
 * 내장 도구 없는 agy 세션(`AcpToolOnlyConfig`)의 파일 배치와 권한 규칙.
 *
 * agy 1.5.9 실측(2026-11-15, gemini-3.8-flash): `--agent`로 내장 컴포넌트를 뺀 커스텀 에이전트를 고르고 MCP 서버를
 * 그 gemini-dir의 `config/mcp_config.json`에 두면, 모델이 받는 도구는 이 서버의 `mcp_<server>_<tool>`과
 * agy 고유 보조 도구(`manage_task`·`list_resources`·`read_resource`)뿐이다. 파일 읽기·셸·디렉터리 목록은 "도구 없음"으로
 * 실패했다. 다른 조합은 모두 실패했다: 에이전트 `tools: []`는 MCP 도구까지 지우고, `tools: [<이름>]`은 레지스트리에서
 * 못 찾고, `eager`를 불리언으로 주면 설정 전체가 거부되고(도구 이름별 맵이어야 한다), `eager`가 없으면 도구가
 * `call_mcp_tool` 간접 호출로만 보인다.
 */
export const TOOL_ONLY_AGENT_NAME = "fleet-bridge";

const AGENT_DEFINITION = `---
name: ${TOOL_ONLY_AGENT_NAME}
description: Fleet Messages bridge agent with no built-in tools.
mainAgent: true
subagent: false
excludeDefaultComponents: true
inheritMcp: true
---
# Fleet bridge
Use only the provided MCP tools.
`;

/** agy가 보조 도구로 남기는 것들. 파일·셸에 닿지 않으며(실측) 브리지는 이 호출을 Messages로 내보내지 않는다. */
export const AGY_INERT_TOOL_TITLES: ReadonlySet<string> = new Set([
  "Run manage_task",
  "Run list_resources",
  "Run read_resource",
]);

/** 이 서버의 도구 호출 제목 접두. `session/request_permission`과 `tool_call`의 title이 이 꼴이다(실측). */
export function toolOnlyTitlePrefix(serverName: string): string {
  return `Run mcp_${serverName}_`;
}

export interface ToolOnlyLayout {
  /** `agy acp`에 덧붙일 인자. */
  readonly args: readonly string[];
  /** 세션 cwd — gemini-dir 아래의 빈 디렉터리. */
  readonly cwd: string;
}

export async function writeToolOnlyLayout(geminiDir: string, config: AcpToolOnlyConfig): Promise<ToolOnlyLayout> {
  const configDir = path.join(geminiDir, "config");
  const cwd = path.join(geminiDir, "workspace");
  await mkdir(path.join(configDir, "agents"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(configDir, "agents", `${TOOL_ONLY_AGENT_NAME}.md`), AGENT_DEFINITION);
  const tools = Object.fromEntries(config.toolNames.map((name) => [name, { eager: true }]));
  await writeFile(path.join(configDir, "mcp_config.json"), `${JSON.stringify({
    mcpServers: {
      [config.serverName]: {
        url: config.url,
        headers: { ...config.headers },
        timeoutSeconds: config.callTimeoutSeconds,
        tools,
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return { args: ["--agent", TOOL_ONLY_AGENT_NAME], cwd };
}
