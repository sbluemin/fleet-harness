// 브라우저로 나가는 전역 옵션 DTO. fleet-infra의 GlobalOptionsData에서 내부 격리 키(version)를
// 제외하고, 시스템 프롬프트 주입 방식과 메타포 토글만 boolean으로 표면화한다.

export interface GlobalSettingsState {
  readonly replaceSystemPrompt: boolean;
  readonly enableMetaphor: boolean;
}

export interface GlobalSettingsMutationResult {
  readonly state: GlobalSettingsState;
}
