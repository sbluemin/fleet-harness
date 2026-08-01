/**
 * CLI별 설정 정의
 * 각 CLI의 spawn 파라미터와 백엔드 구성을 관리합니다.
 */

import type { McpServer } from '@agentclientprotocol/sdk';
import type {
  CliBackendConfig,
  CliSpawnConfig,
  ConnectionOptions,
  McpServerConfig,
} from '../types/config.js';
import { resolveNpxPath, buildNpxArgs } from '../utils/npx.js';
import { cleanEnvironment } from '../utils/env.js';
import { resolveCursorSpawnModel } from '../models/ModelRegistry.js';

/** CLI 백엔드 설정 전체 맵 */
export const CLI_BACKENDS = {
  claude: {
    id: 'claude',
    cliCommand: 'claude',
    protocol: 'acp',
    authRequired: true,
    npxPackage: '@agentclientprotocol/claude-agent-acp@0.33.1',
    modes: [
      { id: 'default', label: 'Default' },
      { id: 'plan', label: 'Plan' },
      { id: 'bypassPermissions', label: 'YOLO' },
    ],
    supportsSessionClose: true,
    supportsSessionLoad: true,
    requiresModelAtSpawn: false,
    usesNpxBridge: true,
    defaultMaxTokens: 16_384,
  },
  codex: {
    id: 'codex',
    cliCommand: 'codex',
    protocol: 'codex-app-server',
    authRequired: true,
    appServerArgs: ['app-server', '--listen', 'stdio://'],
    modes: [
      { id: 'default', label: 'Plan' },
      { id: 'autoEdit', label: 'Auto Edit' },
      { id: 'yolo', label: 'Full Auto' },
    ],
    supportsSessionClose: true,
    supportsSessionLoad: true,
    requiresModelAtSpawn: false,
    usesNpxBridge: false,
    defaultMaxTokens: 100_000,
  },
  cursor: {
    id: 'cursor',
    cliCommand: 'cursor-agent',
    protocol: 'acp',
    authRequired: true,
    acpArgs: ['acp'],
    modes: [
      { id: 'agent', label: 'Agent' },
    ],
    supportsSessionClose: false,
    supportsSessionLoad: true,
    requiresModelAtSpawn: true,
    usesNpxBridge: false,
    defaultMaxTokens: 200_000,
  },
} as const satisfies Record<string, CliBackendConfig>;

export type CliType = keyof typeof CLI_BACKENDS;

/**
 * CLI별 spawn 설정을 생성합니다.
 *
 * @param cli - CLI 종류
 * @param options - 연결 옵션
 * @returns spawn 설정
 */
export function createSpawnConfig(
  cli: CliType,
  options: ConnectionOptions,
): CliSpawnConfig {
  const backend: CliBackendConfig = CLI_BACKENDS[cli];

  // npx 브릿지 패키지를 사용하는 경우 (Claude ACP)
  if (backend.npxPackage) {
    const cleanEnv = cleanEnvironment(process.env, options.env);
    const npxPath = resolveNpxPath(cleanEnv);
    const npxArgs = buildNpxArgs(backend.npxPackage);

    if (backend.npxExtraArgs) {
      npxArgs.push(...backend.npxExtraArgs);
    }
    if (backend.acpArgs) {
      npxArgs.push(...backend.acpArgs);
    }

    return {
      command: npxPath,
      args: npxArgs,
      useNpx: true,
    };
  }

  // Codex app-server native spawn
  if (backend.appServerArgs) {
    const command = options.cliPath ?? backend.cliCommand;
    return {
      command,
      args: [...backend.appServerArgs],
      useNpx: false,
    };
  }

  // CLI를 직접 spawn하는 경우 (Cursor)
  const command = options.cliPath ?? backend.cliCommand;
  const args = backend.acpArgs ? [...backend.acpArgs] : [];

  if (cli === 'cursor' && options.model) {
    // Cursor global option은 acp subcommand 앞에 와야 하므로 기존 acp 인자 앞에 삽입합니다.
    args.unshift('--model', resolveCursorSpawnModel(options.model, options.effort));
  }

  return {
    command,
    args,
    useNpx: false,
  };
}

/**
 * CLI의 백엔드 설정을 가져옵니다.
 *
 * @param cli - CLI 종류
 * @returns 백엔드 설정
 */
export function getBackendConfig(cli: CliType): CliBackendConfig {
  return CLI_BACKENDS[cli];
}

/**
 * Claude 계열 CLI인지 판별합니다.
 *
 * @param cli - CLI 종류
 * @returns Claude 계열 여부
 */
export function isClaudeFamily(cli: CliType): cli is 'claude' {
  return cli === 'claude';
}

/**
 * CLI별 YOLO 모드 ID를 반환합니다.
 *
 * @param cli - CLI 종류
 * @returns ACP session/set_mode에 전달할 모드 ID
 */
export function getYoloModeId(cli: CliType): string {
  switch (cli) {
    case 'claude':
      return 'bypassPermissions';
    case 'cursor':
      return 'agent';
    case 'codex':
      return 'yolo';
  }
}

/**
 * 모든 백엔드 설정을 반환합니다.
 */
export function getAllBackendConfigs(): CliBackendConfig[] {
  return Object.values(CLI_BACKENDS);
}

/**
 * `-c key=value` CLI 오버라이드 인자로 변환합니다.
 *
 * @param overrides - 설정 오버라이드 값
 * @returns spawn 인자 배열
 */
export function buildConfigOverrideArgs(overrides: string[]): string[] {
  return overrides.flatMap((override) => ['-c', override]);
}

// ─── MCP 서버 설정 변환 ──────────────────────────────

/**
 * McpServerConfig 배열을 Codex용 `-c` 인자 배열로 변환합니다.
 * Codex는 ACP mcpServers 대신 config.toml 오버라이드로 MCP 서버를 등록하여
 * tool_timeout_sec를 제어합니다.
 *
 * @param servers - 통합 MCP 서버 설정 배열
 * @returns `-c key=value` 형태의 문자열 배열 (buildConfigArgs에 전달용)
 */
export function mcpServerConfigsToCodexArgs(servers: McpServerConfig[]): string[] {
  const args: string[] = [];
  for (const server of servers) {
    const prefix = `mcp_servers.${server.name}`;
    args.push(`${prefix}.url="${server.url}"`);
    if (server.headers && server.headers.length > 0) {
      // Codex streamable_http은 http_headers (HashMap<String, String>) 필드 사용
      const headerEntries = server.headers
        .map((h) => `"${h.name}" = "${h.value}"`)
        .join(', ');
      args.push(`${prefix}.http_headers={${headerEntries}}`);
    }
    if (server.toolTimeout != null) {
      args.push(`${prefix}.tool_timeout_sec=${server.toolTimeout}`);
    }
  }
  return args;
}

/**
 * McpServerConfig 배열을 ACP McpServer 배열로 변환합니다.
 * Claude는 ACP session/new에 mcpServers로 전달합니다.
 *
 * @param servers - 통합 MCP 서버 설정 배열
 * @returns ACP SDK McpServer 배열
 */
export function mcpServerConfigsToAcp(servers: McpServerConfig[]): McpServer[] {
  return servers.map((server) => ({
    type: server.type,
    name: server.name,
    url: server.url,
    headers: server.headers ?? [],
  })) as McpServer[];
}
