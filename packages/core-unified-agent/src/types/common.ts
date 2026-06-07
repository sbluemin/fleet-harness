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
