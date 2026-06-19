import { mountCodexApp } from "./codex/main.js";
import type { CodexAppController } from "./codex/main.js";

// Side 패널 헤더의 pane 토글이 호출하는 Vanilla Codex 제어 API를 React 측에 노출한다(host 경계 단일 통로).
export { getCodexPaneCollapsed, setCodexPaneCollapsed, setCodexPresentationMode } from "./codex/main.js";

// Vanilla Codex는 모듈 싱글톤(state/router/command-palette 등)이라 동시에 한 인스턴스만 안전하다.
// 그래서 mount host(`<div class="codex-host">`)와 controller를 이 모듈이 단독 소유하고,
// route/side/modal 컨테이너 사이를 appendChild로 "이동"시킨다 — destroy+remount가 아니라
// 노드 재배치라 Vanilla 클라이언트는 모드 전환에도 파괴되지 않는다(스크롤/팔레트 상태 보존).
let hostNode: HTMLDivElement | null = null;
let controller: CodexAppController | null = null;

export function mountCodexInto(container: HTMLElement, initialWorkspaceId: string | null): void {
  const node = ensureHostNode();
  // 컨테이너가 바뀌었으면(모드 전환) 같은 노드를 새 컨테이너로 옮긴다.
  if (node.parentElement !== container) container.appendChild(node);
  if (!controller) controller = mountCodexApp(node, { initialWorkspaceId });
}

export function setCodexWorkspace(workspaceId: string): void {
  controller?.navigateToWorkspace(workspaceId);
}

export function teardownCodex(): void {
  controller?.destroy();
  controller = null;
  // destroy()가 노드 내부를 비우므로 노드 자체는 재사용 가능하지만, DOM에서는 떼어 둔다.
  if (hostNode?.parentElement) hostNode.parentElement.removeChild(hostNode);
}

function ensureHostNode(): HTMLDivElement {
  if (!hostNode) {
    hostNode = document.createElement("div");
    hostNode.className = "codex-host";
  }
  return hostNode;
}
