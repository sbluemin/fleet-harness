import type { ClaudeGatewayExternalMcpServer } from "@fleet-console/agent-runtime/claude";

/**
 * 독립 CLI(Claude Code)에 함께 싣는 전역 플러그인 하나 — 사령관 플러그인 홈(`<consoleDataDir>/commodore-plugins`)에 받아 둔 설치본.
 * `name`은 Claude Code가 붙이는 플러그인 이름, `mcpServers`는 세션 MCP 선언(`plugin:<플러그인>:<서버>`),
 * `env`는 그 선언의 `${VAR}`에 채울, 사람이 Console에 넣은 키다.
 */
export interface StandaloneCliPlugin {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly mcpServers: Readonly<Record<string, ClaudeGatewayExternalMcpServer>>;
  readonly env: Readonly<Record<string, string>>;
}

/** 전역 목록을 읽지 못해도 CLI는 뜬다 — 플러그인 없이. */
export function readStandaloneCliPlugins(read: (() => readonly StandaloneCliPlugin[]) | undefined): readonly StandaloneCliPlugin[] {
  if (!read) return [];
  try {
    return read();
  } catch (error) {
    console.warn(`[standalone-cli] global plugins unavailable: ${messageOf(error)}`);
    return [];
  }
}

/** 여러 플러그인의 키를 한 환경으로. 같은 이름은 먼저 실린 플러그인 쪽이다(사령관 세션과 같은 규칙). */
export function mergeStandaloneCliPluginEnv(plugins: readonly StandaloneCliPlugin[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const plugin of plugins) for (const [key, value] of Object.entries(plugin.env)) if (!(key in env)) env[key] = value;
  return env;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
