import { useCallback, useSyncExternalStore } from "react";
import {
  CONSOLE_COMMODORE_CREATE_EVENT,
  CONSOLE_UNIFIED_SIDEBAR_CAPABILITY,
  CONSOLE_UNIFIED_SIDEBAR_EVENT,
  consoleSectionCommandUrl,
  isConsoleCommodoreCreateResult,
  isUnifiedSidebarState,
  type ConsoleCommodoreCreateResult,
  type UnifiedSidebarCommand,
  type UnifiedSidebarLayout,
  type UnifiedSidebarMachine,
  type UnifiedSidebarRow,
  type UnifiedSidebarState,
} from "@fleet-console/protocol/desktop/console-section";
import { useDesktopHomeOrigin } from "../../../../core/client/src/integration/desktop-shell.js";

/**
 * Desktop 심리스 사이드바가 통합 배치를 읽고 쓰는 자리.
 * 창이 집에 있든 다른 머신 콘솔에 있든 같은 셸 사건·명령이다. 브라우저·모바일처럼 셸이 없으면 `active`가 거짓이고,
 * 그때는 이 콘솔 자신의 `commodoreSidebar`를 지금처럼 쓴다. 셸이 능력을 게시하기 전에는 명령도 보내지 않는다.
 */

const CREATE_TIMEOUT_MS = 15_000;
let unifiedState: UnifiedSidebarState | null = null;
const stateListeners = new Set<() => void>();
const createListeners = new Set<(result: ConsoleCommodoreCreateResult) => void>();
const emitState = (): void => { for (const listener of stateListeners) listener(); };
if (typeof window !== "undefined") {
  window.addEventListener(CONSOLE_UNIFIED_SIDEBAR_EVENT, (event) => {
    const value: unknown = (event as CustomEvent).detail;
    if (isUnifiedSidebarState(value)) { unifiedState = value; emitState(); }
  });
  window.addEventListener(CONSOLE_COMMODORE_CREATE_EVENT, (event) => {
    const value: unknown = (event as CustomEvent).detail;
    if (!isConsoleCommodoreCreateResult(value)) return;
    for (const listener of createListeners) listener(value);
  });
}

export interface UnifiedSidebarController {
  /** 셸이 통합 배치를 건네거나, 그 능력을 게시했는가. 거짓이면 기존 섹션 경로를 유지한다. */
  readonly active: boolean;
  readonly layout: UnifiedSidebarLayout | null;
  readonly machines: readonly UnifiedSidebarMachine[];
  readonly rows: readonly UnifiedSidebarRow[];
  readonly run: (command: UnifiedSidebarCommand) => void;
  readonly createCommodore: (input: { readonly consoleId: string; readonly alias: string }) => Promise<ConsoleCommodoreCreateResult>;
}

function unsupported(consoleId: string): ConsoleCommodoreCreateResult {
  return { v: 1, request: "unsupported", consoleId, ok: false, reason: "unsupported" };
}

export function useUnifiedSidebar(): UnifiedSidebarController {
  const shell = useDesktopHomeOrigin();
  const state = useSyncExternalStore((listener) => { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; }, () => unifiedState, () => null);
  const active = state !== null || shell.capabilities.includes(CONSOLE_UNIFIED_SIDEBAR_CAPABILITY);
  const run = useCallback((command: UnifiedSidebarCommand) => {
    if (!active) return;
    location.assign(consoleSectionCommandUrl(location.origin, { unified: command }));
  }, [active]);
  const createCommodore = useCallback((input: { readonly consoleId: string; readonly alias: string }) => {
    if (!active) return Promise.resolve(unsupported(input.consoleId));
    const request = crypto.randomUUID();
    return new Promise<ConsoleCommodoreCreateResult>((resolve) => {
      const finish = (result: ConsoleCommodoreCreateResult) => {
        if (result.request !== request) return;
        createListeners.delete(finish);
        window.clearTimeout(timer);
        resolve(result);
      };
      const timer = window.setTimeout(() => {
        createListeners.delete(finish);
        resolve({ v: 1, request, consoleId: input.consoleId, ok: false, reason: "unavailable" });
      }, CREATE_TIMEOUT_MS);
      createListeners.add(finish);
      location.assign(consoleSectionCommandUrl(location.origin, { createCommodore: { consoleId: input.consoleId, alias: input.alias, request } }));
    });
  }, [active]);
  return {
    active,
    layout: state?.layout ?? null,
    machines: state?.machines ?? [],
    rows: state?.rows ?? [],
    run,
    createCommodore,
  };
}
