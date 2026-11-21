export const COMPUTER_USE_PERMISSIONS = ["accessibility", "screenRecording"] as const;
export type ComputerUsePermission = (typeof COMPUTER_USE_PERMISSIONS)[number];
export interface ComputerUseSettingsStatus {
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly helperAvailable: boolean;
  readonly missingPermissions: readonly ComputerUsePermission[] | null;
  readonly selfCheckFailed: boolean;
}
