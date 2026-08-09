/**
 * agent/external-mcp — executor infrastructure builtin external MCP catalog.
 *
 * 사용자 workspace 설정이 아니라 소스 코드가 소유하는 allowlist resolver다.
 */

import type { McpServerConfig } from "../types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

interface BuiltinExternalMcpCatalogEntry {
  readonly type: "http";
  readonly url: string;
  readonly toolTimeout?: number;
  readonly headers?: never;
}

interface BuiltinExternalMcpResolveOptions {
  readonly reservedIds?: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const BUILTIN_EXTERNAL_MCP_CATALOG = {
  grep_app: { type: "http" as const, url: "https://mcp.grep.app", toolTimeout: 1800 },
} as const satisfies Record<string, BuiltinExternalMcpCatalogEntry>;

const BUILTIN_EXTERNAL_MCP_SERVER_ID_REGEX = /^[a-z][a-z0-9_]*$/;

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

export function resolveBuiltinExternalMcpServers(
  allowed?: readonly string[],
  options: BuiltinExternalMcpResolveOptions = {},
): McpServerConfig[] {
  if (!allowed || allowed.length === 0) return [];
  const reservedIds = new Set(options.reservedIds ?? []);

  return allowed.map((serverId) => {
    validateBuiltinExternalMcpServerId(serverId, reservedIds);

    const entry = BUILTIN_EXTERNAL_MCP_CATALOG[serverId as keyof typeof BUILTIN_EXTERNAL_MCP_CATALOG];
    if (!entry) {
      throw new Error(`Unknown builtin external MCP server "${serverId}".`);
    }

    validateBuiltinExternalMcpCatalogEntry(serverId, entry);

    const config: McpServerConfig = {
      type: entry.type,
      name: serverId,
      url: entry.url,
      toolTimeoutSeconds: entry.toolTimeout,
    };
    assertNoAuthorizationHeader(config);
    return config;
  });
}

function validateBuiltinExternalMcpServerId(serverId: string, reservedIds: ReadonlySet<string>): void {
  if (reservedIds.has(serverId)) {
    throw new Error(`Reserved builtin external MCP server ID "${serverId}" is not allowed.`);
  }
  if (!BUILTIN_EXTERNAL_MCP_SERVER_ID_REGEX.test(serverId)) {
    throw new Error(
      `Invalid builtin external MCP server ID "${serverId}": must match ${BUILTIN_EXTERNAL_MCP_SERVER_ID_REGEX.source}.`,
    );
  }
}

function validateBuiltinExternalMcpCatalogEntry(
  serverId: string,
  entry: BuiltinExternalMcpCatalogEntry,
): void {
  const url = new URL(entry.url);
  if (url.protocol !== "https:") {
    throw new Error(`Builtin external MCP server "${serverId}" must use https: URL.`);
  }
  assertNoAuthorizationHeader({ type: entry.type, name: serverId, url: entry.url, headers: undefined });
}

/** 내부 MCP 세션 하나의 서버 이름과 그 Bearer 토큰. */
export interface InternalMcpSessionToken {
  readonly serverName: string;
  readonly token: string;
}

/**
 * 내부 MCP Bearer 토큰이 외부 MCP 서버로 새지 않았는지, 그리고 서버끼리 토큰을 돌려쓰지 않는지
 * 확인한다.
 *
 * 내부 토큰과 외부 서버 목록을 같은 자식에게 함께 넘기는 호출자는 넘기기 직전에 이것을 불러야
 * 한다. 예전에는 ACP 실행기가 유일한 조립 지점이라 그 안에서 불렀지만, 조립하는 쪽이 바뀌어도
 * 지켜야 하는 불변식은 그대로라 여기에 둔다.
 */
export function assertInternalMcpTokensNotShared(
  mcpServers: readonly McpServerConfig[],
  tokens: readonly InternalMcpSessionToken[],
  reservedIds: readonly string[] = [],
): void {
  if (!tokens.length) return;
  const internalNames = new Set([...tokens.map((token) => token.serverName), ...reservedIds]);
  const tokenOwners = new Map<string, string>();
  for (const { serverName, token } of tokens) {
    const owner = tokenOwners.get(token);
    if (owner) throw new Error(`Internal MCP Bearer token reused by "${owner}" and "${serverName}".`);
    tokenOwners.set(token, serverName);
  }
  for (const server of mcpServers) {
    if (internalNames.has(server.name)) continue;
    for (const { serverName, token } of tokens) {
      if (server.headers?.some((header) => header.value.includes(token))) {
        throw new Error(`Internal MCP Bearer token for "${serverName}" leaked into external MCP server "${server.name}".`);
      }
    }
  }
}

function assertNoAuthorizationHeader(config: McpServerConfig): void {
  const headers = config.headers ?? [];
  if (headers.some((header) => header.name.toLowerCase() === "authorization")) {
    throw new Error(`Builtin external MCP server "${config.name}" must not define Authorization headers.`);
  }
  if (headers.length > 0) {
    throw new Error(`Builtin external MCP server "${config.name}" must not define headers.`);
  }
}
