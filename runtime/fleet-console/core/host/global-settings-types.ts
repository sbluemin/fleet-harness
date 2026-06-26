// 브라우저로 나가는 전역 옵션 DTO. fleet-infra의 GlobalOptionsData에서 내부 격리 키(version)를
// 제외하고, 브라우저에 안전한 General 설정만 표면화한다.

export interface GlobalSettingsState {
  readonly consolePortMode: "dynamic" | "static";
  readonly consoleStaticPort: number | null;
}

export interface GlobalSettingsMutationResult {
  readonly state: GlobalSettingsState;
}
