export const COMPUTER_USE_PERMISSIONS = ["accessibility", "screenRecording"] as const;
/** 설정 화면의 "권한 요청": 빠진 권한을 macOS 요청 창으로 묻고, 간격 안에 다시 누르면 시스템 설정을 연다. */
export const COMPUTER_USE_PERMISSION_REQUEST_PATH = "/api/v1/computer-use/permission-request";
export type ComputerUseOs = "darwin" | "win32";
export type ComputerUsePermission = (typeof COMPUTER_USE_PERMISSIONS)[number];
export interface ComputerUseSettingsStatus {
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly helperAvailable: boolean;
  readonly missingPermissions: readonly ComputerUsePermission[] | null;
  /** TCC가 권한을 판정하는 앱의 표시 이름(Fleet Console, Fleet Console Dev, 터미널 등). 읽지 못하면 null. */
  readonly permissionHolder: string | null;
  readonly selfCheckFailed: boolean;
  /** 헬퍼가 도는 호스트 OS. 문구 선택과 권한 행 표시에만 쓴다. 없으면 macOS로 읽는다(옛 호스트). */
  readonly os?: ComputerUseOs;
}
