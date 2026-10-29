import type { ClaudeGatewayExternalMcpServer, ClaudeMcpControl, ClaudeProcessSpawner } from "./contracts.js";
import { toVendorProcessSpawner } from "./process-spawn.js";
import { runVendorMcpControl } from "./vendor-sdk.js";

export interface OpenClaudeMcpControlOptions {
  /** 설치된 Claude Code 실행 파일. 생략하면 SDK 동봉본이다. */
  readonly executablePath?: string;
  /** 자식에게 줄 기반 환경. 여기서 config dir 과 보안 저장소 두 변수만 바꾸고 모델 자격은 뺀다. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 호출자가 만들어 둔 빈 `CLAUDE_CONFIG_DIR`. 자식의 MCP 캐시가 여기 쌓이고, 지우는 것은 호출자다. */
  readonly configDir: string;
  readonly cwd: string;
  /**
   * 토큰을 어느 보안 저장소에 둘지. `shared`면 Console 의 격리 자식들(`launch-env.ts`)과 사용자 터미널이 쓰는 기본
   * `Claude Code-credentials` 항목이다 — 그래야 여기서 받은 토큰을 사령관·목표 세션이 같은 서버 이름과 설정으로 쓴다.
   * `isolated`는 config dir 에서 파생된 별도 항목이라 실제 저장소를 건드리지 않는다.
   */
  readonly credentials: "shared" | "isolated";
  /** 붙일 서버. 이름과 `{type,url,headers}`가 토큰 열쇠라 세션들이 쓰는 것과 글자 그대로 같아야 한다. */
  readonly servers: Readonly<Record<string, ClaudeGatewayExternalMcpServer>>;
  readonly spawnProcess?: ClaudeProcessSpawner;
}

/**
 * MCP 인증만 다루는 Claude 자식을 연다. 모델 턴을 보내지 않으므로 로그인이나 사용량이 필요 없다. 디스크 설정 층과
 * ambient MCP 는 읽지 않고, 넘긴 서버만 붙인다.
 */
export function openClaudeMcpControl(options: OpenClaudeMcpControlOptions): ClaudeMcpControl {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value;
  // 모델을 부르지 않는 자식이다 — 자격과 게이트웨이 좌표를 싣지 않는다.
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"]) delete env[key];
  env.CLAUDE_CONFIG_DIR = options.configDir;
  if (options.credentials === "shared") env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "";
  else delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const mcpServers = Object.fromEntries(Object.entries(options.servers).map(([name, server]) => [name, server.type === "stdio"
    ? { type: "stdio", command: server.command, ...(server.args ? { args: [...server.args] } : {}), ...(server.env ? { env: { ...server.env } } : {}) }
    : { type: server.type, url: server.url, ...(server.headers ? { headers: { ...server.headers } } : {}) }]));
  return runVendorMcpControl({
    options: {
      env,
      cwd: options.cwd,
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      mcpServers,
      ...(options.executablePath === undefined ? {} : { pathToClaudeCodeExecutable: options.executablePath }),
      ...(options.spawnProcess === undefined ? {} : { spawnClaudeCodeProcess: toVendorProcessSpawner(options.spawnProcess) }),
      stderr: () => undefined,
    },
  });
}
