/**
 * core-hud/border-bridge.ts — 에디터 테두리 색상 및 레이블 브릿지
 *
 * 에디터 테두리에 표시되는 다음 3가지 시각 요소를 동적으로 제어한다:
 *  1. 테두리 색상 (상/하단 공통, 기본은 sep 색상)
 *  2. 상단 테두리 중앙 레이블 (ANSI 포함, protocol 라벨용)
 *  3. 상단 테두리 우측 레이블 (순수 텍스트, operation name용)
 *
 * 모듈 레벨 set/get 인터페이스를 통해 외부 도메인이 각 요소를 독립적으로 제어한다.
 */

// ── 변수 ──

let editorBorderColor: string | null = null;
let editorRightLabel: string | null = null;
let editorTopRightLabel: string | null = null;

// ── 함수 ──

/** 에디터 테두리 색상을 ANSI 코드로 설정 (null이면 기본 sep 색상 사용) */
export function setEditorBorderColor(ansiCode: string | null): void {
  editorBorderColor = ansiCode;
}

/** 현재 설정된 에디터 테두리 색상 ANSI 코드를 반환 (미설정 시 null) */
export function getEditorBorderColor(): string | null {
  return editorBorderColor;
}

/** 에디터 상단 테두리 중앙에 표시할 레이블(ANSI 포함)을 설정 */
export function setEditorRightLabel(label: string | null): void {
  editorRightLabel = label;
}

/** 현재 설정된 에디터 상단 테두리 중앙 레이블을 반환 */
export function getEditorRightLabel(): string | null {
  return editorRightLabel;
}

/** 에디터 상단 테두리 우측에 표시할 순수 텍스트 레이블을 설정 (ANSI 미포함) */
export function setEditorTopRightLabel(label: string | null): void {
  editorTopRightLabel = label;
}

/** 현재 설정된 에디터 상단 테두리 우측 순수 텍스트 레이블을 반환 */
export function getEditorTopRightLabel(): string | null {
  return editorTopRightLabel;
}
