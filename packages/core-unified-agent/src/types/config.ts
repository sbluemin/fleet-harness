/**
 * CLI 설정 및 구성 타입 정의
 */

import type { CliType } from '../config/CliConfigs.js';

/** 통신 프로토콜 */
export type ProtocolType = 'acp' | 'codex-app-server';

/** 에이전트 모드 옵션 */
export interface AgentMode {
  /** 모드 ID (session/set_mode에 전달되는 값) */
  id: string;
  /** 표시 라벨 */
  label: string;
  /** 설명 (선택) */
  description?: string;
}

/** CLI 스폰 설정 */
export interface CliSpawnConfig {
  /** 실행 커맨드 (e.g., 'claude', 'npx') */
  command: string;
  /** 커맨드 인자 */
  args: string[];
  /** npx를 사용하는지 여부 */
  useNpx: boolean;
}

/** CLI 백엔드 설정 */
export interface CliBackendConfig {
  /** CLI 식별자 */
  id: string;
  /** CLI 커맨드 */
  cliCommand: string;
  /** 통신 프로토콜 */
  protocol: ProtocolType;
  /** 인증 필요 여부 */
  authRequired: boolean;
  /** ACP 모드 인자 (ACP 프로토콜인 경우) */
  acpArgs?: string[];
  /** npx 패키지 (브릿지인 경우) */
  npxPackage?: string;
  /** npx 패키지 실행 시 bin 뒤에 전달할 추가 인자 */
  npxExtraArgs?: string[];
  /** app-server 시작 인자 (Codex native spawn용) */
  appServerArgs?: string[];
  /** 사용 가능한 에이전트 모드 목록 (session/set_mode 지원 시) */
  modes?: AgentMode[];
  /** session/close 지원 여부 */
  supportsSessionClose: boolean;
  /** session/load 지원 여부 */
  supportsSessionLoad: boolean;
  /** 모델을 spawn 시점에 전달해야 하는지 여부 */
  requiresModelAtSpawn: boolean;
  /** npx 브릿지 실행 여부 */
  usesNpxBridge: boolean;
  /** 기본 최대 토큰 */
  defaultMaxTokens: number;
  /** 기본 환경변수 (프록시 등 설정용) */
  defaultEnv?: Record<string, string>;
}

/** 통합 MCP 서버 설정 (백엔드 무관 공통 타입) */
export interface McpServerConfig {
  /** 전송 방식 */
  type: 'http';
  /** MCP 서버 이름 */
  name: string;
  /** MCP 서버 URL */
  url: string;
  /** HTTP 헤더 (인증 등) */
  headers?: { name: string; value: string }[];
  /** MCP tool call 타임아웃 (초).
   *  Codex: `-c mcp_servers.{name}.tool_timeout_sec` 으로 전달.
   *  Claude: 현재 ACP에서 미지원, 향후 `_meta` 확장 예정. */
  toolTimeout?: number;
}

/** 연결 옵션 */
export interface ConnectionOptions {
  /** 작업 디렉토리 */
  cwd: string;
  /** 타임아웃 (ms) — requestTimeout/initTimeout에 매핑 */
  timeout?: number;
  /** 프롬프트 유휴 타임아웃 (ms).
   *  스트리밍 활동 없이 이 시간이 경과하면 프롬프트 타임아웃.
   *  미지정 시 SDK 기본값(120초) 사용. 0 이하이면 비활성화. */
  promptIdleTimeout?: number;
  /** YOLO 모드 (자동 승인) */
  yoloMode?: boolean;
  /** 커스텀 환경변수 */
  env?: Record<string, string>;
  /** 커스텀 CLI 경로 */
  cliPath?: string;
  /** 클라이언트 정보 */
  clientInfo?: {
    name: string;
    version: string;
  };
  /** 모델 지정 */
  model?: string;
  /** spawn 시 모델 ID 조립에 필요한 reasoning effort */
  effort?: string;
  /** CLI 설정 오버라이드 — Codex `-c key=value` 형태로 전달 */
  configOverrides?: string[];
}

/** CLI 감지 결과 */
export interface CliDetectionResult {
  /** CLI 종류 */
  cli: CliType;
  /** CLI 경로 */
  path: string;
  /** 사용 가능 여부 */
  available: boolean;
  /** 버전 (감지 가능한 경우) */
  version?: string;
  /** 지원 프로토콜 목록 */
  protocols: ProtocolType[];
}

/** 통합 클라이언트 옵션 */
export interface UnifiedClientOptions extends ConnectionOptions {
  /** CLI 선택 (미지정 시 자동 감지) */
  cli?: CliType;
  /** 자동 권한 승인 */
  autoApprove?: boolean;
  /** 클라이언트 파일 I/O(fs.readTextFile/writeTextFile) 허용 여부 (기본: true). ACP 백엔드에만 적용된다. */
  fsAccess?: boolean;
  /** Claude 계열에서만 의미한다. true이면 자식 Claude Code 프로세스에
   * `--strict-mcp-config`를 주입하여 사용자 글로벌·프로젝트의 MCP 자동 로딩을
   * 차단한다. ACP로 명시 등록한 MCP는 유지되며, OAuth 인증 경로에는 영향이 없다.
   * Claude 외 CLI(codex)는 본 옵션을 무시한다. 기본값 undefined. */
  strictMcp?: boolean;
  /** Codex에서만 의미한다. true이면 disconnect 전에 thread/archive를 호출해
   * 세션을 resume picker에서 숨긴다. 재개 시에는 thread/unarchive 후 resume한다.
   * Codex 외 CLI는 본 옵션을 무시한다. 기본값 undefined. */
  archiveSessionOnDisconnect?: boolean;
  /** 재개할 기존 세션 ID */
  sessionId?: string;
  /** 세션 초기 시스템 지침.
   * 기본 prepend 모드에서는 fresh 세션의 첫 user turn 앞에 한 번만 선행 text block으로 주입하며,
   * resetSession()은 이를 다시 대기시킵니다. 기존 세션의 connect(sessionId) 및 loadSession()에는 주입하지 않습니다. */
  systemPrompt?: string;
  /** 시스템 지침 적용 방식 (기본: "prepend").
   * prepend는 기존처럼 fresh 세션의 첫 user turn 앞에 선행 text block으로 주입합니다.
   * replace는 CLI 자체 system prompt를 대체하며 Claude 계열에서만 지원합니다. */
  readonly systemPromptMode?: 'prepend' | 'replace';
  /** 에이전트에 연결할 MCP 서버 목록 (선택) */
  mcpServers?: McpServerConfig[];
}

/**
 * 연결 상태 및 이벤트 타입 정의
 * JSON-RPC 통신은 공식 ACP SDK에서 처리하므로 최소한의 타입만 유지
 */

/** 연결 상태 */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'initializing'
  | 'ready'
  | 'error'
  | 'closed';

/** 클라이언트 정보 */
export interface ClientInfo {
  name: string;
  version: string;
}

/** 구조화 로그 항목 */
export interface StructuredLogEntry {
  /** 로그 메시지 */
  message: string;
  /** 로그 소스 */
  source: 'stderr';
  /** ISO 8601 타임스탬프 */
  timestamp: string;
  /** CLI 종류 */
  cli?: string;
  /** ACP 세션 ID */
  sessionId?: string;
}

/** 연결 이벤트 타입 */
export interface ConnectionEvents {
  /** 상태 변경 */
  stateChange: (state: ConnectionState) => void;
  /** 에러 발생 */
  error: (error: Error) => void;
  /** 프로세스 종료 */
  exit: (code: number | null, signal: string | null) => void;
  /** stderr 로그 */
  log: (message: string) => void;
  /** 구조화 stderr 로그 */
  logEntry: (entry: StructuredLogEntry) => void;
}
