/**
 * agent/external-mcp — executor infrastructure builtin external MCP catalog.
 *
 * 사용자 workspace 설정이 아니라 소스 코드가 소유하는 allowlist resolver다.
 */

import type { McpServerConfig } from "@dotobokuri/fleet-unified-agent";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

interface BuiltinExternalMcpCatalogEntry {
  readonly type: "http";
  readonly url: string;
  readonly toolTimeout?: number;
  readonly headers?: never;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const BUILTIN_EXTERNAL_MCP_CATALOG = {
  grep_app: { type: "http" as const, url: "https://mcp.grep.app", toolTimeout: 1800 },
} as const satisfies Record<string, BuiltinExternalMcpCatalogEntry>;

const BUILTIN_EXTERNAL_MCP_SERVER_ID_REGEX = /^[a-z][a-z0-9_]*$/;
const RESERVED_EXTERNAL_MCP_SERVER_IDS = new Set(["carrier", "fleet-carriers", "fleet-tools", "fleet-wiki", "wiki"]);

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

export function resolveBuiltinExternalMcpServers(allowed?: readonly string[]): McpServerConfig[] {
  if (!allowed || allowed.length === 0) return [];

  return allowed.map((serverId) => {
    validateBuiltinExternalMcpServerId(serverId);

    const entry = BUILTIN_EXTERNAL_MCP_CATALOG[serverId as keyof typeof BUILTIN_EXTERNAL_MCP_CATALOG];
    if (!entry) {
      throw new Error(`Unknown builtin external MCP server "${serverId}".`);
    }

    validateBuiltinExternalMcpCatalogEntry(serverId, entry);

    const config: McpServerConfig = {
      type: entry.type,
      name: serverId,
      url: entry.url,
      toolTimeout: entry.toolTimeout,
    };
    assertNoAuthorizationHeader(config);
    return config;
  });
}

function validateBuiltinExternalMcpServerId(serverId: string): void {
  if (RESERVED_EXTERNAL_MCP_SERVER_IDS.has(serverId)) {
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

function assertNoAuthorizationHeader(config: McpServerConfig): void {
  const headers = config.headers ?? [];
  if (headers.some((header) => header.name.toLowerCase() === "authorization")) {
    throw new Error(`Builtin external MCP server "${config.name}" must not define Authorization headers.`);
  }
  if (headers.length > 0) {
    throw new Error(`Builtin external MCP server "${config.name}" must not define headers.`);
  }
}
