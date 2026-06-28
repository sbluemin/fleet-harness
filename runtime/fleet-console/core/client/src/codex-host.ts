import { mountNavigatorApp } from "./codex/main.js";
import type { NavigatorController, NavigatorRequest } from "./codex/main.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { NavigatorRequest } from "./codex/main.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// Vanilla Codex는 모듈 싱글톤이라 동시에 한 인스턴스만 안전하다.
// mount host(`<div class="codex-host">`)와 controller를 이 모듈이 단독 소유하고,
// appendChild로 컨테이너에 "이동"시킨다 — destroy+remount가 아니라
// 노드 재배치라 Navigator 검색 상태 등이 보존된다.
let hostNode: HTMLDivElement | null = null;
let navigatorController: NavigatorController | null = null;
let onRequestOpenReaderHandler: ((r: NavigatorRequest) => void) | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

export function setOnRequestOpenReader(
  handler: ((r: NavigatorRequest) => void) | null,
): void {
  onRequestOpenReaderHandler = handler;
}

export function mountNavigatorInto(
  container: HTMLElement,
  initialTheaterId: string | null,
): void {
  const node = ensureHostNode();
  if (node.parentElement !== container) container.appendChild(node);
  if (!navigatorController) {
    navigatorController = mountNavigatorApp(node, {
      initialTheaterId,
      onRequest: (r) => onRequestOpenReaderHandler?.(r),
    });
  } else {
    navigatorController.setTheater(initialTheaterId);
  }
}

export function setNavigatorTheater(theaterId: string | null): void {
  navigatorController?.setTheater(theaterId);
}

export function teardownCodex(): void {
  navigatorController?.destroy();
  navigatorController = null;
  if (hostNode?.parentElement) hostNode.parentElement.removeChild(hostNode);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function ensureHostNode(): HTMLDivElement {
  if (!hostNode) {
    hostNode = document.createElement("div");
    hostNode.className = "codex-host";
  }
  return hostNode;
}
