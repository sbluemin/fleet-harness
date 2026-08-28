import "./styles/theme.css";
import "./styles/layout.css";
import "@fleet-console/markdown/styles.css";
import "./styles/components.css";

import { mountNavigatorInto } from "./components/navigator.js";
import type { NavigatorController, NavigatorRequest } from "./components/navigator.js";
import { loadInitialData, setCurrentWorkspaceId, subscribeState } from "./state.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { NavigatorController, NavigatorRequest } from "./components/navigator.js";

export interface MountNavigatorOptions {
  readonly initialTheaterId: string | null;
  readonly onRequest: (r: NavigatorRequest) => void;
}

// ─── Mount entry point ────────────────────────────────────────────────────────

export function mountNavigatorApp(
  root: HTMLElement,
  options: MountNavigatorOptions,
): NavigatorController {
  // Navigator(검색 + 엔트리 리스트)는 mermaid diagram을 렌더하지 않으므로 hydrator를 설치하지
  // 않는다. diagram hydrator는 reader 컨테이너에서만 reading-controller가 설치한다.
  if (options.initialTheaterId) {
    setCurrentWorkspaceId(options.initialTheaterId);
  }

  const controller = mountNavigatorInto(root, {
    initialTheaterId: options.initialTheaterId,
    onRequest: options.onRequest,
  });

  // Theater 전환 시 데이터 리로드 + Navigator 갱신
  const unsubscribeState = subscribeState(() => {
    // 상태 변화는 navigator.ts 내부 subscribeState 구독이 처리
    // 여기서는 추가 side-effect 없음
  });

  void loadInitialData();

  const originalDestroy = controller.destroy.bind(controller);
  return {
    destroy(): void {
      unsubscribeState();
      originalDestroy();
    },
    setTheater(theaterId: string | null): void {
      setCurrentWorkspaceId(theaterId);
      void loadInitialData();
      controller.setTheater(theaterId);
    },
    setCurrentEntry(entryId: string | null): void {
      controller.setCurrentEntry(entryId);
    },
    setActiveTag(tag: string | null): void {
      controller.setActiveTag(tag);
    },
    refreshHealth(): void {
      controller.refreshHealth();
    },
    refreshLocale(): void {
      controller.refreshLocale();
    },
  };
}
