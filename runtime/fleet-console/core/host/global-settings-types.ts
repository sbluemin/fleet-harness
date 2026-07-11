import type { ConsoleThemeId, UiFontSettings } from "./console-settings.js";

// 브라우저로 나가는 General 설정 DTO. console-settings.ts의 ConsoleSettingsData에서
// 내부 격리 키(version)를 제외하고 flat으로 변환해 표면화한다.

export interface GlobalSettingsState {
  readonly consolePortMode: "dynamic" | "static";
  readonly consoleStaticPort: number | null;
  readonly language: "auto" | "en" | "ko";
  readonly theme: ConsoleThemeId;
  readonly uiFont: UiFontSettings;
}

export interface GlobalSettingsMutationResult {
  readonly state: GlobalSettingsState;
}
