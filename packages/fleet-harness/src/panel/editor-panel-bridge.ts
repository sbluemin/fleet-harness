/**
 * panel/editor-panel-bridge.ts — ua-panel editor-replace 렌더 브리지
 *
 * widget sync 타이밍에 활성 editor-replace 컴포넌트도 함께 갱신합니다.
 */

interface InvalidationTarget {
  invalidate: () => void;
}

let activeEditorPanel: InvalidationTarget | null = null;

export function setActiveEditorPanel(target: InvalidationTarget | null): void {
  activeEditorPanel = target;
}

export function requestEditorPanelRender(): void {
  activeEditorPanel?.invalidate();
}
