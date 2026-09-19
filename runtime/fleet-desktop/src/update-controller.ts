import type { ShellUpdateStage } from "./shell-update.js";

/**
 * 창 안에서 사용자가 Console 업데이트를 눌렀다. 동의는 그 자리에서 받았으므로 여기서 다시 묻지 않는다 —
 * 남은 일은 수행뿐이다. 관리형 설치본은 자기를 제자리에서 갈아 끼울 수 없어, 셸이 앱을 재시작하고
 * 진입 흐름이 새 Console을 조달한다.
 *
 * 셸 자신의 갱신은 이 길을 쓰지 않는다(shell-update.ts). 그쪽은 설치본이 앱을 다시 띄우므로,
 * 여기서 쓰는 재시작 예약을 함께 걸면 앱이 두 번 뜬다.
 */
export interface ConsoleRelaunchOptions {
  readonly currentVersion: () => string;
  readonly prepareToQuit: () => Promise<void>;
  readonly relaunch: () => void;
  readonly quit: () => void;
}

export interface ConsoleRelaunchController {
  applyRequested(version: string): Promise<void>;
}

export function createConsoleRelaunchController(options: ConsoleRelaunchOptions): ConsoleRelaunchController {
  return {
    async applyRequested(version: string) {
      // 이미 그 버전이면 재시작은 아무것도 바꾸지 않는다. 설명 없는 앱 재시작만 남고,
      // 사용자는 같은 버전과 같은 표식 앞으로 돌아온다.
      if (version === options.currentVersion()) return;
      await options.prepareToQuit();
      options.relaunch();
      options.quit();
    },
  };
}

export function createNoopConsoleRelaunchController(): ConsoleRelaunchController {
  return { applyRequested: async () => undefined };
}

/**
 * 네이티브 메뉴가 셸 갱신에 대해 할 수 있는 일. 창 안의 알림·버전 행과 같은 상태를 읽고 같은 명령을 보낸다 —
 * 두 자리가 서로 다른 사실을 말하지 않게 하기 위해 상태는 한 곳(셸 갱신기)에만 있다.
 */
export interface NativeUpdateActions {
  readonly enabled: () => boolean;
  readonly stage: () => ShellUpdateStage;
  readonly version: () => string | null;
  readonly check: () => void;
  readonly download: () => void;
  readonly restart: () => void;
}

export function createDisabledNativeUpdateActions(): NativeUpdateActions {
  return {
    enabled: () => false,
    stage: () => "idle",
    version: () => null,
    check: () => undefined,
    download: () => undefined,
    restart: () => undefined,
  };
}
