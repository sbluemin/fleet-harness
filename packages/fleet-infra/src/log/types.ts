/**
 * core-log/types.ts — 순수 타입/인터페이스 정의
 *
 * 부수효과 없음: import만으로 globalThis를 조작하지 않는다.
 * 런타임 브릿지 로직은 bridge.ts에 분리되어 있다.
 */

// ── 타입/인터페이스 ──

/** 로그 레벨 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 개별 로그 항목 */
export interface LogEntry {
  /** ISO 8601 타임스탬프 */
  timestamp: string;
  /** 로그 레벨 */
  level: LogLevel;
  /** 로그 카테고리 */
  category: string;
  /** 로그 소스 (확장명 등) */
  source: string;
  /** 로그 메시지 */
  message: string;
  /** Footer 표시 제외 여부 */
  hideFromFooter?: boolean;
}

/** 로그 기록 옵션 */
export interface LogOptions {
  /** 로그 카테고리 */
  category?: string;
  /** Footer 표시 제외 여부 */
  hideFromFooter?: boolean;
}

/** 등록된 로그 카테고리 메타데이터 */
export interface LogCategoryMeta {
  /** 카테고리 ID (로그 호출 시 사용하는 문자열) */
  id: string;
  /** 사람이 읽을 수 있는 레이블 */
  label: string;
  /** 설명 (선택) */
  description?: string;
}

/** 로그 설정 (settings.json 저장용) */
export interface LogSettings {
  /** 활성화 여부 (기본: false) */
  enabled?: boolean;
  /** 파일 로그 활성화 여부 (기본: true when enabled) */
  fileLog?: boolean;
  /** Footer 표시 활성화 여부 (기본: true when enabled) */
  footerDisplay?: boolean;
  /** 최소 로그 레벨 (기본: "debug") */
  minLevel?: LogLevel;
  /** 비활성화된 카테고리 ID 목록 (settings.json 저장) */
  disabledCategories?: string[];
}

/** core-log가 globalThis를 통해 제공하는 API */
export interface CoreLogAPI {
  /** 디버그 로그 기록 */
  debug(source: string, message: string, options?: LogOptions): void;
  /** 정보 로그 기록 */
  info(source: string, message: string, options?: LogOptions): void;
  /** 경고 로그 기록 */
  warn(source: string, message: string, options?: LogOptions): void;
  /** 에러 로그 기록 */
  error(source: string, message: string, options?: LogOptions): void;
  /** 범용 로그 기록 */
  log(level: LogLevel, source: string, message: string, options?: LogOptions): void;
  /** 현재 활성화 여부 */
  isEnabled(): boolean;
  /** 활성화/비활성화 토글 */
  setEnabled(enabled: boolean): void;
  /** 최근 로그 항목 조회 */
  getRecentLogs(count?: number): LogEntry[];
  /** 로그 카테고리 등록 */
  registerCategory(meta: LogCategoryMeta): void;
  /** 등록된 모든 카테고리 조회 */
  getRegisteredCategories(): LogCategoryMeta[];
}

// ── 상수 ──

/** category 미지정 시 사용하는 기본값 */
export const DEFAULT_LOG_CATEGORY = "general";

/** globalThis 브릿지 키 (AGENTS.md: globalThis key는 types.ts에 정의) */
export const CORE_LOG_KEY = "__core_log__";

/**
 * Footer bridge용 globalThis 키.
 * 값: LogFooterBridge 객체 (아래 참조).
 *
 * 통신 흐름:
 *   HUD setupStatusBar → 객체 생성 + requestRender 콜백 주입
 *   log → .lines 갱신(최대 5줄) 후 .requestRender() 호출 → Footer 즉시 재렌더 (중앙 정렬)
 *
 * border-bridge.ts와 동일한 간접 통신 패턴이되,
 * requestRender 콜백을 통해 push 방식 즉시 렌더를 보장한다.
 */
export const CORE_LOG_FOOTER_KEY = "__core_log_footer__";

/** Footer bridge 객체 형태 — globalThis[CORE_LOG_FOOTER_KEY]의 런타임 값 */
export interface LogFooterBridge {
  /** Footer에 표시할 plain text 배열 (null이면 표시 없음, 최대 5줄) */
  lines: string[] | null;
  /** HUD가 주입하는 렌더 트리거 콜백 (null이면 HUD 미로드 상태) */
  requestRender: (() => void) | null;
}

/** 로그 레벨 우선순위 (낮을수록 상세) */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
