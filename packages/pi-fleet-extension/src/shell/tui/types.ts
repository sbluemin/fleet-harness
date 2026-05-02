/**
 * core-shell — 공용 타입
 *
 * 순수 쉘 팝업 유틸리티. 에이전트 개념 없음.
 */

/** 팝업 실행 결과 */
export interface ShellPopupResult {
  exitCode: number | null;
  signal?: number;
  cancelled: boolean;
}

/** 팝업 실행 옵션 — 명령어를 받아 PTY 팝업으로 띄움 */
export interface ShellPopupOptions {
  /** 실행할 쉘 명령어 */
  command: string;
  /** 팝업 타이틀 */
  title?: string;
  /** 작업 디렉토리 */
  cwd?: string;
  /** 자식 프로세스에 병합할 환경 변수 (process.env에 override) */
  env?: Record<string, string>;
}

export type PopupState = "interactive" | "exited";

/** shell popup 브릿지 */
export type InteractiveShellBridge = {
  open(opts: ShellPopupOptions): Promise<ShellPopupResult | void>;
  isOpen(): boolean;
};

export const HEADER_LINES = 4;
export const FOOTER_LINES = 2;

let shellPopupBridge: InteractiveShellBridge | null = null;

export function getShellPopupBridge(): InteractiveShellBridge | null {
  return shellPopupBridge;
}

export function setShellPopupBridge(bridge: InteractiveShellBridge | null): void {
  shellPopupBridge = bridge;
}
