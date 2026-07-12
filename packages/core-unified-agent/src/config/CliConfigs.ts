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
import type { CodexJsonValue } from '../types/codex-app-server.js';
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
    npxPackage: '@agentclientprotocol/codex-acp@1.1.2',
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
 * Codex ACP 브릿지(`codex-acp`)가 읽는 `CODEX_CONFIG` 환경변수 값을 생성합니다.
 * 브릿지는 이 JSON 맵을 `thread/start`/`thread/resume` config에 spread하므로,
 * 설정 오버라이드를 argv 대신 env로 주입합니다.
 *
 * @param configOverrides - `key=value` 형태의 설정 오버라이드 배열 (dotted key는 중첩 객체로 확장)
 * @param baseConfigJson - 호출자가 이미 지정한 CODEX_CONFIG(JSON) 값. 유효한 JSON 객체면 시작점으로 병합.
 * @returns JSON 문자열(맵에 키가 하나 이상일 때) 또는 undefined(빈 맵)
 */
export function buildCodexConfigEnv(
  configOverrides?: string[],
  baseConfigJson?: string,
): string | undefined {
  const map = parseBaseConfigMap(baseConfigJson);

  for (const override of configOverrides ?? []) {
    const eqIndex = override.indexOf('=');
    if (eqIndex < 0) {
      continue;
    }
    const key = override.slice(0, eqIndex);
    const rawValue = override.slice(eqIndex + 1);
    assignNestedKey(map, key, parseOverrideValue(rawValue));
  }

  if (Object.keys(map).length === 0) {
    return undefined;
  }
  return JSON.stringify(map);
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

// baseConfigJson을 JSON 객체 맵으로 파싱한다. 유효한 JSON 객체가 아니면(부재/배열/스칼라/파싱 실패)
// 조용히 빈 맵에서 시작한다.
function parseBaseConfigMap(baseConfigJson?: string): Record<string, CodexJsonValue> {
  if (!baseConfigJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(baseConfigJson) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, CodexJsonValue>;
    }
  } catch {
    // 잘못된 JSON은 무시하고 빈 맵에서 시작한다.
  }
  return {};
}

// 오버라이드 값을 파싱한다. JSON.parse를 우선 시도하고, 실패하면 감싼 큰따옴표 한 쌍만 제거해
// 원시 문자열로 사용한다. TOML inline table 등 비-JSON TOML 값은 원시 문자열로 강등된다
// (best-effort; 현재 이 경로에는 프로덕션 호출자가 없다).
function parseOverrideValue(raw: string): CodexJsonValue {
  try {
    return JSON.parse(raw) as CodexJsonValue;
  } catch {
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      return raw.slice(1, -1);
    }
    return raw;
  }
}

// dotted key를 중첩 객체로 확장해 값을 할당한다.
// (예: `mcp_servers.fleet.url` → `{ mcp_servers: { fleet: { url: ... } } }`)
// 중간 경로에 객체가 아닌 값이 있으면 새 객체로 덮어쓴다.
function assignNestedKey(
  target: Record<string, CodexJsonValue>,
  dottedKey: string,
  value: CodexJsonValue,
): void {
  const segments = dottedKey.split('.');
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const existing = cursor[segment];
    if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
      cursor = existing as Record<string, CodexJsonValue>;
    } else {
      const nested: Record<string, CodexJsonValue> = {};
      cursor[segment] = nested;
      cursor = nested;
    }
  }
  cursor[segments[segments.length - 1]] = value;
}
