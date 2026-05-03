/**
 * core-settings/types.ts — 순수 타입/인터페이스 정의
 *
 * 부수효과 없음: import만으로 globalThis를 조작하지 않는다.
 * 런타임 브릿지 로직은 bridge.ts에 분리되어 있다.
 */

/** 팝업에 표시할 필드 하나 */
export interface DisplayField {
  label: string;
  value: string;
  /** theme 색상 이름 (e.g. "accent", "warning", "dim"). 기본값: "accent" */
  color?: string;
}

/** 섹션 표시 설정 — 각 확장이 등록 */
export interface SectionDisplayConfig {
  /** settings.json 키 — 확장 디렉토리 이름 (e.g. "metaphor-directive-refinement") */
  key: string;
  /** 팝업에 표시할 이름 (e.g. "Directive Refinement", "Auto Summarize") */
  displayName: string;
  /** 팝업이 열릴 때마다 호출 — 최신 상태의 필드 목록 반환 */
  getDisplayFields(): DisplayField[];
}

/** core-settings가 globalThis를 통해 제공하는 API */
export interface CoreSettingsAPI {
  /** settings.json에서 특정 섹션 읽기 */
  load<T = Record<string, unknown>>(sectionKey: string): T;
  /** settings.json에 특정 섹션 저장 */
  save(sectionKey: string, data: unknown): void;
  /** 팝업 표시용 섹션 등록 */
  registerSection(config: SectionDisplayConfig): void;
  /** 팝업 표시용 섹션 해제 */
  unregisterSection(sectionKey: string): void;
  /** 팝업 표시용 섹션 목록 조회 */
  getSections(): SectionDisplayConfig[];
}
