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
  'claude-zai': {
    id: 'claude-zai',
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
    defaultEnv: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      API_TIMEOUT_MS: '3000000',
    },
  },
  'claude-kimi': {
    id: 'claude-kimi',
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
    defaultEnv: {
      ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
      ENABLE_TOOL_SEARCH: 'false',
      ANTHROPIC_MODEL: 'kimi-k2.7-code',
      CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k2.7-code',
      API_TIMEOUT_MS: '3000000',
    },
  },
  'claude-glm': {
    id: 'claude-glm',
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
    defaultEnv: {
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      // ZhipuAI Claude Code 권장 슬롯 매핑 — 직접 launch(Native PTY) 경로에서도
      // haiku/sonnet/opus 별칭이 GLM 모델로 해석되도록 env로 고정한다.
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1',
      API_TIMEOUT_MS: '3000000',
    },
  },
  codex: {
    id: 'codex',
    cliCommand: 'codex',
    protocol: 'codex-app-server',
    authRequired: true,
    npxPackage: '@zed-industries/codex-acp@0.14.0',
    acpArgs: [],
    appServerArgs: ['app-server', '--listen', 'stdio://'],
    modes: [
      { id: 'default', label: 'Plan' },
      { id: 'autoEdit', label: 'Auto Edit' },
      { id: 'yolo', label: 'Full Auto' },
    ],
    supportsSessionClose: true,
    supportsSessionLoad: true,
    requiresModelAtSpawn: false,
    usesNpxBridge: true,
    defaultMaxTokens: 100_000,
  },
  'opencode-go': {
    id: 'opencode-go',
    cliCommand: 'opencode',
    protocol: 'acp',
    authRequired: false,
    acpArgs: ['acp'],
    modes: [
      { id: 'build', label: 'Build' },
      { id: 'plan', label: 'Plan' },
    ],
    supportsSessionClose: true,
    supportsSessionLoad: true,
    requiresModelAtSpawn: true,
    usesNpxBridge: false,
    defaultMaxTokens: 128_000,
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

  // CLI를 직접 spawn하는 경우 (Cursor, OpenCode 계열)
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
 * @returns Claude 계열('claude' | 'claude-zai' | 'claude-kimi' | 'claude-glm') 여부
 */
export function isClaudeFamily(cli: CliType): cli is 'claude' | 'claude-zai' | 'claude-kimi' | 'claude-glm' {
  return cli === 'claude' || cli === 'claude-zai' || cli === 'claude-kimi' || cli === 'claude-glm';
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
    case 'claude-zai':
    case 'claude-kimi':
    case 'claude-glm':
      return 'bypassPermissions';
    case 'opencode-go':
      return 'build';
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
 * Codex developer instruction을 `-c` 오버라이드 값으로 변환합니다.
 *
 * @param systemPrompt - 세션 시작 시 주입할 시스템 지침
 * @returns `developer_instructions="..."` 형태의 설정 배열
 */
export function buildCodexDeveloperInstructionConfig(systemPrompt?: string | null): string[] {
  if (!systemPrompt) {
    return [];
  }

  return [`developer_instructions="${escapeTomlBasicString(systemPrompt)}"`];
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

// TOML basic string 이스케이프. 단축 이스케이프가 없는 제어문자(U+0000-U+001F)와
// DEL(U+007F)은 \uXXXX 형태로 폴백 이스케이프해 깨진 TOML 생성을 방지한다.
function escapeTomlBasicString(value: string): string {
  return value.replace(/[\u0000-\u001f"\\\u007f]/g, (char) => {
    switch (char) {
      case '\b':
        return '\\b';
      case '\t':
        return '\\t';
      case '\n':
        return '\\n';
      case '\f':
        return '\\f';
      case '\r':
        return '\\r';
      case '"':
        return '\\"';
      case '\\':
        return '\\\\';
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });
}
